import os
import json
import uvicorn
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
from dotenv import load_dotenv
load_dotenv()
from hbp100 import HBP100

app = FastAPI(title="HBP100 Privacy Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    stream: Optional[bool] = True
    model: Optional[str] = "openai/gpt-oss-120b"
    temperature: Optional[float] = 1.0
    max_tokens: Optional[int] = 2048
    top_p: Optional[float] = 1.0
    reasoning_effort: Optional[str] = "medium"

class ModelData(BaseModel):
    id: str
    object: str
    created: int
    owned_by: str

class ModelsResponse(BaseModel):
    object: str
    data: List[ModelData]

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
engine = HBP100()

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "hbp100-groq-gateway", "version": "1.0.0"}

@app.get("/v1/models")
async def list_models():
    return ModelsResponse(
        object="list",
        data=[
            ModelData(
                id="openai/gpt-oss-120b",
                object="model",
                created=1700000000,
                owned_by="groq"
            )
        ]
    )

@app.post("/v1/chat/completions")
async def chat_completion(request: ChatRequest):
    if not GROQ_API_KEY:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not configured")
    session = HBP100Session("chat_completion")
    session_id = f"conv_{os.urandom(8).hex()}"
    sessions[session_id] = session
    masked_messages = []
    last_metadata = {}
    for msg in request.messages:
        if msg.role == "user":
            result = engine.process(
                msg.content,
                session_id=session_id,  
                intent="general_chat"
            )
            if hasattr(result, 'metadata') and result.metadata:
                last_metadata.update(result.metadata)
            
            masked_text = result.masked_text if hasattr(result, 'masked_text') else msg.content
            print(f"orignal: {msg.content}")
            print(f"masked:   {masked_text}")
            
            masked_messages.append({"role": msg.role, "content": masked_text})
        else:
            masked_messages.append({"role": msg.role, "content": msg.content})

    async def stream_generator():
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                response = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {GROQ_API_KEY}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "messages": masked_messages,
                        "stream": True,
                        "temperature": request.temperature,
                        "max_completion_tokens": request.max_tokens,
                        "top_p": request.top_p,
                        "model": request.model or "openai/gpt-oss-120b",
                        "reasoning_effort": request.reasoning_effort,
                        "stop": None,
                    }
                )
                if response.status_code != 200:
                    error_text = await response.aread()
                    yield f"data: {json.dumps({'error': f'Groq API error: {error_text.decode()}'})}\n\n"
                    return
                full_response = ""
                buffer = ""
                try:
                    async for chunk in response.aiter_bytes():
                        text = chunk.decode()
                        buffer += text
                        lines = buffer.split('\n')
                        buffer = lines[-1] if lines else ""
                        for line in lines[:-1]:
                            if line.startswith("data: "):
                                data = line[6:]
                                if data == "[DONE]":
                                    continue
                                try:
                                    chunk_data = json.loads(data)
                                    delta = chunk_data.get("choices", [{}])[0].get("delta", {}).get("content")
                                    if delta:
                                        full_response += delta
                                        yield f"data: {json.dumps({'choices': [{'delta': {'content': delta}}]})}\n\n"
                                except:
                                    pass
                except Exception as e:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"
                restored_response = full_response
                if full_response:
                    try:
                        restored_response = engine.restore(full_response, session_id=session_id)
                    except Exception as e:
                        print(f"restoration error: {e}")
                        restored_response = full_response
                yield f"data: {json.dumps({'choices': [{'delta': {'content': restored_response, 'raw_content': restored_response, 'masked_content': full_response}}]})}\n\n"
                yield "data: [DONE]\n\n"
            except httpx.TimeoutException:
                yield f"data: {json.dumps({'error': 'Request timed out'})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(
        stream_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)