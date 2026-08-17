use axum::{
    extract::State,
    response::{
        sse::{Event, Sse},
        Json,
    },
    routing::{get, post},
    Router,
};
use dotenv::dotenv;
use futures::Stream;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::env;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
#[derive(Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}
#[derive(Deserialize)]
struct ChatRequest {
    messages: Vec<ChatMessage>,
    stream: Option<bool>,
    model: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    top_p: Option<f32>,
    reasoning_effort: Option<String>,
}
#[derive(Serialize)]
struct ModelData {
    id: String,
    object: String,
    created: u64,
    owned_by: String,
}
#[derive(Serialize)]
struct ModelsResponse {
    object: String,
    data: Vec<ModelData>,
}
#[derive(Clone)]
struct AppState {
    hbp100: Arc<Mutex<hbp100::HBP100>>,
    llm_url: String,
    groq_api_key: String,
}
async fn list_models() -> Json<ModelsResponse> {
    Json(ModelsResponse {
        object: "list".to_string(),
        data: vec![ModelData {
            id: "openai/gpt-oss-120b".to_string(),
            object: "model".to_string(),
            created: 1700000000,
            owned_by: "groq".to_string(),
        }],
    })
}
async fn chat_completion(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let llm_url = state.llm_url.clone();
    let api_key = state.groq_api_key.clone();

    let user_message = req
        .messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("");
    let (masked_text, metadata) = {
        let mut engine = state.hbp100.lock().await;
        let result = engine.process(user_message, Some("general_chat"));
        (result.masked_text.clone(), result.metadata.clone())
    };
    let mut masked_messages = req.messages.clone();
    if let Some(last) = masked_messages.last_mut() {
        if last.role == "user" {
            last.content = masked_text;
        }
    }
    let temperature = req.temperature.unwrap_or(1.0);
    let max_tokens = req.max_tokens.unwrap_or(2048);
    let top_p = req.top_p.unwrap_or(1.0);
    let reasoning_effort = req
        .reasoning_effort
        .clone()
        .unwrap_or_else(|| "medium".to_string());
    let model = req
        .model
        .unwrap_or_else(|| "openai/gpt-oss-120b".to_string());
    let stream = async_stream::stream! {
        let client = reqwest::Client::new();
        println!("sending to Groq with model: {}", model);
        let llm_response = client
            .post(&llm_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "messages": masked_messages,
                "stream": true,
                "temperature": temperature,
                "max_completion_tokens": max_tokens,
                "top_p": top_p,
                "model": model,
                "reasoning_effort": reasoning_effort,
                "stop": null,
            }))
            .send()
            .await;
        match llm_response {
            Ok(res) => {
                println!("response status: {}", res.status());
                if !res.status().is_success() {
                    let error_text = res.text().await.unwrap_or_default();
                    println!("❌ Error response: {}", error_text);
                    yield Ok(
                        Event::default().data(
                            serde_json::json!({
                                "error": format!("Groq API error: {}", error_text)
                            })
                            .to_string()
                        )
                    );
                    return;
                }
                let mut response_stream = res.bytes_stream();
                let mut buffer = String::new();
                let mut full_response = String::new();
                while let Some(chunk_result) =
                    futures::StreamExt::next(&mut response_stream).await
                {
                    match chunk_result {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            buffer.push_str(&text);
                            let lines: Vec<String> = buffer
                                .split('\n')
                                .map(|s| s.to_string())
                                .collect();
                            buffer = lines
                                .last()
                                .cloned()
                                .unwrap_or_default();
                            for line in &lines[..lines.len().saturating_sub(1)] {
                                let line = line.trim_end_matches('\r');
                                if !line.starts_with("data: ") {
                                    continue;
                                }
                                let data = &line[6..];
                                if data == "[DONE]" {
                                    continue;
                                }
                                let chunk =
                                    match serde_json::from_str::<serde_json::Value>(data) {
                                        Ok(value) => value,
                                        Err(_) => continue,
                                    };
                                if let Some(delta) =
                                    chunk["choices"][0]["delta"]["content"].as_str()
                                {
                                    full_response.push_str(delta);
                                    yield Ok(
                                        Event::default().data(
                                            serde_json::json!({
                                                "choices": [{
                                                    "delta": {
                                                        "content": delta
                                                    }
                                                }]
                                            })
                                            .to_string()
                                        )
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            yield Ok(
                                Event::default().data(
                                    serde_json::json!({
                                        "error": format!("Stream error: {}", e)
                                    })
                                    .to_string()
                                )
                            );
                            break;
                        }
                    }
                }
                if !full_response.is_empty() {
                    let restored_result = {
                        let mut engine = state.hbp100.lock().await;
                        engine.restore_with_metadata(&full_response, metadata.clone())
                    };
                    yield Ok(
                        Event::default().data(
                            serde_json::json!({
                                "choices": [{
                                    "delta": {
                                        "content": restored_result,
                                        "raw_content": restored_result,
                                        "masked_content": full_response,
                                    }
                                }]
                            })
                            .to_string()
                        )
                    );
                }
                yield Ok(Event::default().data("[DONE]"));
            }
            Err(e) => {
                println!("❌ Request failed: {}", e);
                yield Ok(
                    Event::default().data(
                        serde_json::json!({
                            "error": format!("Request failed: {}", e)
                        })
                        .to_string()
                    )
                );
            }
        }
    };
    Sse::new(stream)
}
async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "hbp100-groq-gateway",
        "version": "0.1.0"
    }))
}
#[tokio::main]
async fn main() {
    dotenv().ok();
    tracing_subscriber::fmt::init();

    let groq_api_key = env::var("GROQ_API_KEY")
        .expect("GROQ_API_KEY environment variable not set");

    let llm_url = "https://api.groq.com/openai/v1/chat/completions".to_string();

    let hbp100_engine = Arc::new(Mutex::new(hbp100::HBP100::new()));

    let app_state = Arc::new(AppState {
        hbp100: hbp100_engine,
        llm_url,
        groq_api_key,
    });

    let app = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completion))
        .route("/health", get(health_check))
        .layer(CorsLayer::permissive())
        .with_state(Arc::clone(&app_state));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .unwrap();
    println!("🔐 HBP100 Groq Gateway running on http://localhost:8080");
    axum::serve(listener, app).await.unwrap();
}