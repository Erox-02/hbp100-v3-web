import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Send, Square, Menu, Sun, Moon, MessageSquare, Trash2, Loader2, Eye, EyeOff } from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  raw?: string;
  masked?: string;
  showRaw?: boolean;
}

interface Conversation {
  id: string;
  name: string;
  messages: Message[];
  lastModified: number;
}

const API_BASE = "https://hbp100-v3-web.onrender.com" || "http://localhost:8080";

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [models, setModels] = useState<string[]>(["openai/gpt-oss-120b"]);
  const [selectedModel, setSelectedModel] = useState<string>("openai/gpt-oss-120b");
  const [theme, setTheme] = useState<"light" | "dark">(
    localStorage.getItem("theme") as "light" | "dark" ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [processingDots, setProcessingDots] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const dotIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pendingMessageRef = useRef<string>("");
  const activeConv = conversations.find((c) => c.id === activeId) || null;
  const messages = activeConv?.messages || [];
  useEffect(() => {
    if (isStreaming || isLoading) {
      const dots = ["●", "●●", "●●●", "●●●●"];
      let i = 0;
      dotIntervalRef.current = setInterval(() => {
        setProcessingDots(dots[i % dots.length]);
        i++;
      }, 300);
    } else {
      if (dotIntervalRef.current) {
        clearInterval(dotIntervalRef.current);
        dotIntervalRef.current = null;
      }
      setProcessingDots("");
    }
    return () => {
      if (dotIntervalRef.current) {
        clearInterval(dotIntervalRef.current);
        dotIntervalRef.current = null;
      }
    };
  }, [isStreaming, isLoading]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);
  useEffect(() => {
    const stored = localStorage.getItem("conversations");
    if (stored) {
      try {
        setConversations(JSON.parse(stored));
      } catch {}
    }
    checkBackend();
  }, []);
  useEffect(() => {
    if (conversations.length > 0) {
      localStorage.setItem("conversations", JSON.stringify(conversations));
    }
  }, [conversations]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);
  const checkBackend = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) {
        setBackendOk(true);
        const modelRes = await fetch(`${API_BASE}/v1/models`);
        if (modelRes.ok) {
          const data = await modelRes.json();
          const modelList = data.data?.map((m: any) => m.id) || ["openai/gpt-oss-120b"];
          setModels(modelList);
          if (modelList.length > 0 && !selectedModel) {
            setSelectedModel(modelList[0]);
          }
        }
      } else {
        setBackendOk(false);
      }
    } catch {
      setBackendOk(false);
    }
  };

  const createConversation = () => {
    const conv: Conversation = {
      id: crypto.randomUUID(),
      name: `Chat ${new Date().toLocaleString()}`,
      messages: [],
      lastModified: Date.now(),
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    return conv.id;
  };
  const deleteConversation = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) {
      const remaining = conversations.filter((c) => c.id !== id);
      setActiveId(remaining.length > 0 ? remaining[0].id : null);
    }
  };
  const toggleRawView = (msgId: string) => {
    setConversations((prev) =>
      prev.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === msgId ? { ...m, showRaw: !m.showRaw } : m
        ),
      }))
    );
  };
  const sendMessage = async () => {
    const messageToSend = pendingMessageRef.current.trim();
    
    if (!messageToSend || isLoading) {
      return;
    }
    setInput("");
    pendingMessageRef.current = "";
    let convId = activeId;
    if (!convId) {
      convId = createConversation();
    }
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: messageToSend,
      timestamp: Date.now(),
    };
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? { ...c, messages: [...c.messages, userMsg], lastModified: Date.now() }
          : c
      )
    );
    setIsLoading(true);
    setError(null);
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      raw: "",
      masked: "",
      showRaw: false,
    };
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId ? { ...c, messages: [...c.messages, assistantMsg] } : c
      )
    );
    abortControllerRef.current = new AbortController();
    try {
      let streamedContent = "";
      let rawContent = "";
      let maskedContent = "";
      let hasReceivedContent = false;
      let restoredContent = "";
      setIsStreaming(true);
      setIsLoading(false);
      const allMessages = [...conv.messages, userMsg];
      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          temperature: 1.0,
          max_tokens: 2048,
          top_p: 1.0,
          model: selectedModel || "openai/gpt-oss-120b",
          reasoning_effort: "medium",
          stop: null,
        }),
        signal: abortControllerRef.current.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              if (delta) {
                if (delta.raw_content && delta.masked_content) {
                  restoredContent = delta.raw_content;
                  rawContent = delta.raw_content;
                  maskedContent = delta.masked_content;
                  setConversations((prev) =>
                    prev.map((c) => {
                      if (c.id !== convId) return c;
                      const msgs = [...c.messages];
                      const last = msgs[msgs.length - 1];
                      if (last && last.id === assistantMsg.id) {
                        msgs[msgs.length - 1] = {
                          ...last,
                          content: maskedContent,
                          raw: maskedContent,
                          masked: restoredContent,
                        };
                      }
                      return { ...c, messages: msgs };
                    })
                  );
                  continue;
                }
                const chunkContent = delta.content || "";
                if (chunkContent) {
                  streamedContent += chunkContent;
                  hasReceivedContent = true; 
                  setConversations((prev) =>
                    prev.map((c) => {
                      if (c.id !== convId) return c;
                      const msgs = [...c.messages];
                      const last = msgs[msgs.length - 1];
                      if (last && last.id === assistantMsg.id) {
                        msgs[msgs.length - 1] = {
                          ...last,
                          content: streamedContent,
                          raw: rawContent || streamedContent,
                          masked: maskedContent || streamedContent,
                        };
                      }
                      return { ...c, messages: msgs };
                    })
                  );
                }
              }
            } catch {
            }
          }
        }
      }

      setIsStreaming(false);
      const finalContent = restoredContent || streamedContent;
      if (finalContent) {
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.id === assistantMsg.id) {
              msgs[msgs.length - 1] = {
                ...last,
                content: maskedContent || finalContent,
                raw: restoredContent || finalContent,
                masked: maskedContent || finalContent,
              };
            }
            return { ...c, messages: msgs };
          })
        );
      } else if (!hasReceivedContent) {
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.id === assistantMsg.id) {
              msgs[msgs.length - 1] = { ...last, content: "No response received" };
            }
            return { ...c, messages: msgs };
          })
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.id === assistantMsg.id) {
              msgs[msgs.length - 1] = { ...last, content: "Generation stopped" };
            }
            return { ...c, messages: msgs };
          })
        );
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.id === assistantMsg.id) {
              msgs[msgs.length - 1] = {
                ...last,
                content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
              };
            }
            return { ...c, messages: msgs };
          })
        );
      }
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    pendingMessageRef.current = value;
  };
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
    setIsStreaming(false);
  };
  if (backendOk === false) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="text-6xl mb-4">🔌</div>
          <h2 className="text-2xl font-bold mb-2">Backend Disconnected</h2>
          <p className="text-muted-foreground mb-4">
            Please start your backend on port 8080
          </p>
          <button
            onClick={checkBackend}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (backendOk === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  return (
    <div className="flex h-screen bg-background">
      <div
        className={`${
          sidebarOpen ? "w-72" : "w-0"
        } flex-shrink-0 border-r border-border bg-muted/30 transition-all duration-300 overflow-hidden`}
      >
        <div className="flex flex-col h-full p-3 w-72">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Conversations</h2>
            <button
              onClick={createConversation}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
            >
              New
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-8">
                No conversations yet
              </div>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    conv.id === activeId
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted"
                  }`}
                  onClick={() => setActiveId(conv.id)}
                >
                  <MessageSquare className="w-4 h-4 flex-shrink-0" />
                  <span className="flex-1 text-sm truncate">{conv.name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(conv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/20 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1 rounded hover:bg-muted"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold">
              {activeConv?.name || "HBP100 Chat"}
            </h1>
            <span className="text-xs bg-green-500/20 text-green-600 dark:text-green-400 px-2 py-0.5 rounded-full">
              Privacy Protected
            </span>
          </div>
          <div className="flex items-center gap-2">
            {models.length > 0 && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-muted text-sm rounded-md px-3 py-1.5 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              className="p-2 rounded hover:bg-muted transition-colors"
            >
              {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
          </div>
        </header>
        {error && (
          <div className="mx-auto mt-4 max-w-3xl w-full px-4">
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive">
              {error}
              <button
                onClick={() => setError(null)}
                className="ml-2 underline hover:no-underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <h2 className="text-2xl font-bold text-muted-foreground">Hello there</h2>
                <p className="mt-2 text-muted-foreground">Type a message to get started</p>
                <p className="mt-1 text-sm text-muted-foreground/60">
                  Made for future ysws
                </p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`my-4 ${msg.role === "user" ? "flex justify-end" : "flex justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-sm"
                        : "bg-muted rounded-2xl rounded-tl-sm"
                    } px-4 py-2.5`}
                  >
                    {msg.role === "assistant" ? (
                      <>
                        <ReactMarkdown
                          className="prose prose-neutral dark:prose-invert max-w-none"
                          components={{
                            code({ node, inline, className, children, ...props }) {
                              const match = /language-(\w+)/.exec(className || "");
                              return !inline && match ? (
                                <SyntaxHighlighter
                                  style={vscDarkPlus}
                                  language={match[1]}
                                  PreTag="div"
                                  {...props}
                                >
                                  {String(children).replace(/\n$/, "")}
                                </SyntaxHighlighter>
                              ) : (
                                <code className={className} {...props}>
                                  {children}
                                </code>
                              );
                            },
                          }}
                        >
                          {msg.showRaw && msg.raw ? msg.raw : msg.content}
                        </ReactMarkdown>

                        {msg.id === messages[messages.length - 1]?.id && isStreaming && (
                          <span className="inline-block w-1 h-4 animate-pulse bg-primary">▌</span>
                        )}

                        {(msg.raw || msg.masked) && (
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => toggleRawView(msg.id)}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 bg-muted/50 px-2 py-0.5 rounded"
                            >
                              {msg.showRaw ? (
                                <>
                                  <EyeOff className="w-3 h-3" />
                                  Show Restored
                                </>
                              ) : (
                                <>
                                  <Eye className="w-3 h-3" />
                                  Show masked
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="whitespace-pre-wrap break-words text-sm">{msg.content}</div>
                    )}
                    <div className="mt-1 text-xs opacity-70">
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))
            )}

            {(isLoading || isStreaming) && (
              <div className="flex items-center gap-3 text-muted-foreground py-2">
                <div className="flex items-center gap-1">
                  <span className="text-sm font-medium">Processing</span>
                  <span className="text-lg font-mono w-12 text-center text-primary">
                    {processingDots}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground/60">Masking PII</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="border-t border-border bg-background/80 px-4 py-4 backdrop-blur">
          <div className="mx-auto max-w-3xl">
            <form
              onSubmit={handleSubmit}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-background/80 p-2 shadow-sm"
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="min-h-[56px] max-h-[200px] w-full resize-none border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
                rows={1}
                disabled={isLoading || isStreaming}
              />
              <div className="flex justify-between items-center px-2">
                <span className="text-xs text-muted-foreground/60">
                  Your Sensetive data is protected.
                </span>
                <div className="flex gap-2">
                  {isLoading || isStreaming ? (
                    <button
                      type="button"
                      onClick={stopGeneration}
                      className="px-4 py-1.5 bg-destructive text-destructive-foreground rounded-md text-sm font-medium hover:bg-destructive/90"
                    >
                      <Square className="w-4 h-4 inline mr-1" />
                      Stop
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!input.trim()}
                      className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send className="w-4 h-4 inline mr-1" />
                      Send
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
