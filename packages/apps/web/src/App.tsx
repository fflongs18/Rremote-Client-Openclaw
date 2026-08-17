import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type Status = "idle" | "pending" | "started" | "in_progress" | "completed" | "failed" | "cancelled";

interface Client {
  id: string;
  name: string;
  runtime: string;
  connectedAt: number | null;
  online: boolean;
  runtimes?: RuntimeInfo[];
}

interface RuntimeInfo {
  id: string;
  label: string;
  capabilities: string[];
  ready?: boolean;
  detail?: string;
  checkedAt?: number;
}

interface TaskEvent {
  taskId: string;
  sequence: number;
  event: string;
  runId?: string;
  data?: { text?: string };
  timestamp: number;
}

interface Turn {
  id: string;
  taskId?: string;
  prompt: string;
  events: TaskEvent[];
  createdAt: number;
}

interface Conversation {
  id: string;
  clientId: string;
  title: string;
  sessionKey: string;
  runtime: string;
  agentId: string;
  status: Status;
  turns: Turn[];
  updatedAt: number;
}

interface AgentPushMessage {
  version: 1;
  type: "agent-push";
  messageId: string;
  from: string;
  to: string;
  sessionKey?: string;
  title?: string;
  text: string;
  level?: "info" | "success" | "warning" | "error";
  timestamp: number;
  artifact?: { name: string; url: string; mime?: string; size?: number; expiresAt?: number };
}

const STORAGE_KEY = "remote-oc:conversations:v1";
const ACTIVE_KEY = "remote-oc:active-conversation";
const EMPTY_CLIENTS_KEY = "remote-oc:empty-clients:v1";
const terminal = new Set<Status>(["completed", "failed", "cancelled"]);

function uid(): string {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createConversation(clientId: string, runtime = "openclaw"): Conversation {
  const id = uid();
  return {
    id,
    clientId,
    title: "新对话",
    sessionKey: "",
    runtime,
    agentId: "main",
    status: "idle",
    turns: [],
    updatedAt: Date.now(),
  };
}

function sessionSlug(value: string, fallback: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 24);
  return ascii || fallback;
}

function createReadableSessionKey(client: Client | undefined, runtime: string, prompt: string): string {
  const node = sessionSlug(clientDisplayName(client), "agent");
  const runtimeSlug = sessionSlug(runtime, "runtime");
  const topic = sessionSlug(prompt, "chat");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  const shortId = uid().replace(/-/g, "").slice(0, 6).toLowerCase();
  return `rc_${node}_${runtimeSlug}_${topic}_${stamp}_${shortId}`;
}

function loadConversations(): Conversation[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as Conversation[];
    if (!Array.isArray(value)) return [];
    return value.map((conversation) => {
      const migrated = { ...conversation, runtime: conversation.runtime || "openclaw" };
      return migrated.turns.length === 0 && /^remote:[^:]+:web:[0-9a-f-]+$/i.test(migrated.sessionKey)
        ? { ...migrated, sessionKey: "" }
        : migrated;
    });
  } catch {
    return [];
  }
}

function loadEmptyClients(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(EMPTY_CLIENTS_KEY) || "[]") as string[];
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function statusFromEvent(event: string): Status | null {
  if (event === "accepted") return "started";
  if (["started", "output", "tool_use", "tool_result", "turn_done"].includes(event)) return "in_progress";
  if (["completed", "failed", "cancelled"].includes(event)) return event as Status;
  return null;
}

function outputForTurn(turn: Turn): string {
  return turn.events
    .filter((event) => event.event === "output")
    .map((event) => event.data?.text || "")
    .join("");
}

function errorForTurn(turn: Turn): string {
  return turn.events
    .filter((event) => event.event === "failed")
    .map((event) => event.data?.text || "任务执行失败")
    .join("\n");
}

function displayStatus(status: Status): string {
  const labels: Record<Status, string> = {
    idle: "就绪",
    pending: "发送中",
    started: "已接收",
    in_progress: "回复中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function clientDisplayName(client: Client | undefined): string {
  if (!client) return "远程 Agent";
  const host = client.name.replace(/\.local$/i, "");
  const appleModel = host.match(/Mac[-_ ]?(mini|book(?:[-_ ]?(?:air|pro))?|studio|pro)/i);
  if (appleModel) {
    return `Mac ${appleModel[1].replace(/[-_]/g, " ").replace(/book/i, "Book").replace(/air/i, "Air").replace(/pro/i, "Pro")}`;
  }
  return host.length > 24 ? `${host.slice(0, 21)}...` : host;
}

function runtimeOptions(client: Client | undefined): NonNullable<Client["runtimes"]> {
  return client?.runtimes?.length
    ? client.runtimes
    : [{ id: "openclaw", label: "OpenClaw", capabilities: [] }];
}

function defaultRuntime(client: Client | undefined): string {
  const options = runtimeOptions(client);
  return options.find((runtime) => runtime.ready === true)?.id
    || options.find((runtime) => runtime.ready !== false)?.id
    || options[0].id;
}

function clientReady(client: Client): boolean {
  return client.online && (!client.runtimes?.length || client.runtimes.some((runtime) => runtime.ready !== false));
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

export default function App() {
  const [clients, setClients] = useState<Client[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [emptyClientIds, setEmptyClientIds] = useState<Set<string>>(loadEmptyClients);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(ACTIVE_KEY) || "");
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [error, setError] = useState("");
  const [pushes, setPushes] = useState<AgentPushMessage[]>([]);
  const [showPushes, setShowPushes] = useState(false);
  const eventSource = useRef<EventSource | null>(null);
  const messageEnd = useRef<HTMLDivElement | null>(null);
  const initializedClients = useRef(false);
  const knownClientIds = useRef<Set<string>>(new Set());

  const active = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) || null,
    [activeId, conversations],
  );
  const activeClient = clients.find((client) => client.id === active?.clientId);
  const activeClientName = clientDisplayName(activeClient);
  const activeRuntimeOptions = runtimeOptions(activeClient);
  const activeRuntime = activeRuntimeOptions.find((runtime) => runtime.id === active?.runtime);
  const activeRuntimeLabel = activeRuntime?.label || active?.runtime || "OpenClaw";
  const activeRuntimeReady = Boolean(activeClient?.online) && activeRuntime?.ready !== false;
  const activeRuntimeDetail = activeRuntime?.ready === false
    ? activeRuntime.detail || `${activeRuntime.label} 尚未连接`
    : "";
  const currentTurn = active?.turns.at(-1);
  const currentTaskId = currentTurn?.taskId || "";
  const busy = Boolean(active && active.status !== "idle" && !terminal.has(active.status));

  function updateConversation(id: string, update: (value: Conversation) => Conversation): void {
    setConversations((current) => current.map((item) => item.id === id ? update(item) : item));
  }

  function selectClient(clientId: string): void {
    setExpandedClients((current) => {
      const next = new Set(current);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
    const latest = conversations
      .filter((conversation) => conversation.clientId === clientId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) setActiveId(latest.id);
  }

  function newConversation(clientId: string): void {
    const client = clients.find((item) => item.id === clientId);
    const next = createConversation(clientId, defaultRuntime(client));
    setEmptyClientIds((current) => {
      const updated = new Set(current);
      updated.delete(clientId);
      return updated;
    });
    setConversations((current) => [next, ...current]);
    setExpandedClients((current) => new Set(current).add(clientId));
    setActiveId(next.id);
    setMessage("");
    setError("");
  }

  function deleteConversation(conversationId: string): void {
    const target = conversations.find((conversation) => conversation.id === conversationId);
    if (!target || (target.id === activeId && busy)) return;
    const remaining = conversations.filter((conversation) => conversation.id !== conversationId);
    setConversations(remaining);
    if (!remaining.some((conversation) => conversation.clientId === target.clientId)) {
      setEmptyClientIds((current) => new Set(current).add(target.clientId));
    }
    if (activeId !== conversationId) return;
    const next = remaining
      .filter((conversation) => conversation.clientId === target.clientId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setActiveId(next?.id || "");
    setMessage("");
    setError("");
    if (!next) localStorage.removeItem(ACTIVE_KEY);
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem(EMPTY_CLIENTS_KEY, JSON.stringify([...emptyClientIds]));
  }, [emptyClientIds]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await json<Client[]>("/api/clients");
        if (stopped) return;
        setClients(next);
        if (!initializedClients.current) {
          initializedClients.current = true;
          setExpandedClients(new Set(next.map((client) => client.id)));
        }
        setConversations((current) => {
          const additions = next
            .filter((client) => !emptyClientIds.has(client.id) && !knownClientIds.current.has(client.id) && !current.some((conversation) => conversation.clientId === client.id))
            .map((client) => createConversation(client.id, defaultRuntime(client)));
          knownClientIds.current = new Set([...knownClientIds.current, ...next.map((client) => client.id)]);
          return additions.length ? [...current, ...additions] : current;
        });
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [emptyClientIds]);

  useEffect(() => {
    if (activeId || conversations.length === 0) return;
    setActiveId([...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
  }, [activeId, conversations]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.turns, active?.status]);

  useEffect(() => {
    eventSource.current?.close();
    if (!active || !currentTaskId) {
      setConnection("connected");
      return;
    }

    let stopped = false;
    const conversationId = active.id;
    const turnId = currentTurn?.id;
    if (!turnId) return;

    const mergeEvents = (incoming: TaskEvent[]) => {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        turns: conversation.turns.map((turn) => {
          if (turn.id !== turnId) return turn;
          const bySequence = new Map(turn.events.map((item) => [item.sequence, item]));
          for (const item of incoming) bySequence.set(item.sequence, item);
          return { ...turn, events: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence) };
        }),
      }));
    };

    void json<{ task: { status: Status }; events: TaskEvent[] }>(`/api/tasks/${currentTaskId}`)
      .then((result) => {
        if (stopped) return;
        mergeEvents(result.events);
        updateConversation(conversationId, (conversation) => ({ ...conversation, status: result.task.status }));
        if (terminal.has(result.task.status)) source.close();
      })
      .catch((cause) => {
        if (stopped) return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (/404|task not found/i.test(detail)) {
          updateConversation(conversationId, (conversation) => ({ ...conversation, status: "idle" }));
          return;
        }
        setError(detail);
      });

    const source = new EventSource(`/api/tasks/${currentTaskId}/events`);
    eventSource.current = source;
    setConnection("connecting");
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("reconnecting");
    source.addEventListener("task-event", (raw) => {
      const taskEvent = JSON.parse((raw as MessageEvent).data) as TaskEvent;
      mergeEvents([taskEvent]);
      const nextStatus = statusFromEvent(taskEvent.event);
      if (nextStatus) {
        updateConversation(conversationId, (conversation) => ({ ...conversation, status: nextStatus, updatedAt: Date.now() }));
        if (terminal.has(nextStatus)) source.close();
      }
    });
    return () => {
      stopped = true;
      source.close();
    };
  }, [active?.id, currentTaskId]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("agent-push", (raw) => {
      const push = JSON.parse((raw as MessageEvent).data) as AgentPushMessage;
      setPushes((current) => current.some((item) => item.messageId === push.messageId) ? current : [push, ...current].slice(0, 100));
      if (!push.sessionKey) return;
      setConversations((current) => current.map((conversation) => {
        if (conversation.sessionKey !== push.sessionKey || conversation.turns.some((turn) => turn.id === `push:${push.messageId}`)) return conversation;
        const turn: Turn = {
          id: `push:${push.messageId}`,
          prompt: "远端主动推送",
          createdAt: push.timestamp,
          events: [{ taskId: `push:${push.messageId}`, sequence: 1, event: "output", data: { text: push.text }, timestamp: push.timestamp }],
        };
        return { ...conversation, turns: [...conversation.turns, turn], updatedAt: push.timestamp };
      }));
    });
    return () => source.close();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const prompt = message.trim();
    if (!active || !activeRuntimeReady || !prompt || busy) return;
    const conversationId = active.id;
    const turnId = uid();
    const now = Date.now();
    const conversationTitle = active.turns.length === 0 ? prompt.slice(0, 32) : active.title;
    const sessionKey = active.sessionKey || createReadableSessionKey(activeClient, active.runtime, prompt);
    setError("");
    setMessage("");
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: conversationTitle,
      sessionKey,
      status: "pending",
      updatedAt: now,
      turns: [...conversation.turns, { id: turnId, prompt, events: [], createdAt: now }],
    }));
    try {
      const result = await json<{ taskId: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          clientId: active.clientId,
          message: prompt,
          runtime: active.runtime,
          agentId: active.agentId,
          sessionKey,
        }),
      });
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        turns: conversation.turns.map((turn) => turn.id === turnId ? { ...turn, taskId: result.taskId } : turn),
      }));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        status: "failed",
        turns: conversation.turns.map((turn) => turn.id === turnId ? {
          ...turn,
          events: [{ taskId: `local:${turnId}`, sequence: 1, event: "failed", data: { text: detail }, timestamp: Date.now() }],
        } : turn),
      }));
      setError(detail);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function cancel() {
    if (!currentTaskId) return;
    try {
      await json(`/api/tasks/${currentTaskId}/cancel`, { method: "POST", body: "{}" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">OC</span>
          <div><strong>OpenClaw</strong><small>Remote workspace</small></div>
        </div>
        <div className="sidebar-heading"><span>远程 Agent</span><span>{clients.filter((client) => client.online).length} 在线</span></div>
        <nav className="agent-list" aria-label="远程 Agent 和对话">
          {clients.map((client) => {
            const clientConversations = conversations
              .filter((conversation) => conversation.clientId === client.id)
              .sort((a, b) => b.updatedAt - a.updatedAt);
            const expanded = expandedClients.has(client.id);
            const ready = clientReady(client);
            return (
              <section className="agent-group" key={client.id}>
                <button className="agent-row" type="button" onClick={() => selectClient(client.id)}>
                  <span className="agent-avatar">{clientDisplayName(client).trim().slice(0, 1).toUpperCase()}</span>
                  <span className="agent-copy"><strong title={client.name}>{clientDisplayName(client)}</strong><small><i className={ready ? "online" : ""} />{ready ? "可用" : client.online ? "Runtime 未就绪" : "离线"}</small></span>
                  <span className={`chevron ${expanded ? "expanded" : ""}`} aria-hidden="true">›</span>
                </button>
                {expanded && (
                  <div className="conversation-list">
                    {clientConversations.map((conversation) => (
                      <div className={`conversation-item ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                        <button
                          type="button"
                          className="conversation-row"
                          onClick={() => setActiveId(conversation.id)}
                          title={conversation.title}
                        >
                          <span aria-hidden="true">▱</span><span>{conversation.title}</span>
                        </button>
                        <button
                          className="delete-chat"
                          type="button"
                          onClick={() => deleteConversation(conversation.id)}
                          disabled={conversation.id === activeId && busy}
                          title={conversation.id === activeId && busy ? "请先停止当前回复" : "删除对话"}
                          aria-label={`删除对话 ${conversation.title}`}
                        >×</button>
                      </div>
                    ))}
                    <button className="new-chat-inline" type="button" onClick={() => newConversation(client.id)}>
                      <span aria-hidden="true">＋</span> 新对话
                    </button>
                  </div>
                )}
              </section>
            );
          })}
          {clients.length === 0 && <div className="no-agents">正在查找远程 Agent...</div>}
        </nav>
        <div className="sidebar-footer"><span className={`hub-dot ${connection}`} />控制服务 {connection === "connected" ? "已连接" : "连接中"}</div>
      </aside>

      <section className="chat-workspace">
        {active ? (
          <>
            <header className="chat-header">
              <div className="chat-identity">
                <span className="header-avatar">{activeClientName.trim().slice(0, 1).toUpperCase() || "?"}</span>
                <div><h1>{active.title}</h1><p title={activeClient?.name}>{activeClientName} · {active.runtime} · Agent {active.agentId}</p></div>
              </div>
              <div className="header-actions">
                <button className={`notification-button ${pushes.length ? "has-pushes" : ""}`} type="button" onClick={() => setShowPushes((value) => !value)} title="远端主动推送">铃声 {pushes.length ? pushes.length : ""}</button>
                {busy && <button className="icon-button danger" type="button" onClick={cancel} title="停止当前回复" aria-label="停止当前回复">■</button>}
                <button className="new-chat-button" type="button" onClick={() => newConversation(active.clientId)}><span aria-hidden="true">＋</span> 新对话</button>
              </div>
            </header>

            {showPushes && <div className="push-popover">
              <div className="push-popover-title"><strong>远端推送</strong><button type="button" onClick={() => setPushes([])}>清空</button></div>
              {pushes.length === 0 ? <p>暂无主动推送</p> : pushes.map((push) => <button className="push-item" type="button" key={push.messageId} onClick={() => { if (push.sessionKey) setShowPushes(false); }}><span className={`push-level ${push.level || "info"}`} /> <span><strong>{push.title || "远端消息"}</strong><small>{push.text}</small><time>{new Date(push.timestamp).toLocaleString()}</time></span></button>)}
            </div>}

            <div className="session-banner" title="这个标识同时用于远端智能体的 sessionKey">
              <span>执行插件</span>
              <select
                value={active.runtime}
                disabled={active.turns.length > 0}
                onChange={(event) => updateConversation(active.id, (conversation) => ({ ...conversation, runtime: event.target.value }))}
                aria-label="执行插件"
              >
                {activeRuntimeOptions.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.label}{runtime.ready === false ? "（未就绪）" : ""}</option>)}
              </select>
              <span>远端会话</span>
              <code>{active.sessionKey || "发送首条消息后生成可搜索名称"}</code>
            </div>

            <div className="message-scroll">
              {active.turns.length === 0 ? (
                <div className="welcome-state">
                  <span className="welcome-mark">OC</span>
                  <h2>开始与 {activeClientName} 对话</h2>
                  <p>这次对话中的后续消息会保持在同一个 {activeRuntimeLabel} 会话里。</p>
                </div>
              ) : active.turns.map((turn) => {
                const output = outputForTurn(turn);
                const turnError = errorForTurn(turn);
                const isCurrent = turn.id === currentTurn?.id;
                return (
                  <div className="turn" key={turn.id}>
                    <article className="message user-message">
                      <div className="message-avatar user">你</div>
                      <div className="message-content"><div className="message-meta">你 <time>{new Date(turn.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{turn.prompt}</p></div>
                    </article>
                    <article className="message assistant-message">
                      <div className="message-avatar agent">OC</div>
                      <div className="message-content">
                        <div className="message-meta">{activeClientName}{isCurrent && <span className={`status-pill ${active.status}`}>{displayStatus(active.status)}</span>}</div>
                        {output && <pre>{output}</pre>}
                        {turnError && <div className="turn-error">{turnError}</div>}
                        {!output && !turnError && isCurrent && busy && <div className="typing"><span /><span /><span /></div>}
                        {!output && !turnError && (!isCurrent || !busy) && <p className="muted-response">没有返回文本内容</p>}
                      </div>
                    </article>
                  </div>
                );
              })}
              <div ref={messageEnd} />
            </div>

            <div className="composer-wrap">
              {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
              <form className="chat-composer" onSubmit={submit}>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder={!activeClient?.online ? "该 Agent 当前不在线" : activeRuntimeDetail || "发送消息..."}
                  rows={1}
                  disabled={!activeRuntimeReady}
                />
                <button className="send-button" disabled={!activeRuntimeReady || !message.trim() || busy} title={activeRuntimeDetail || "发送消息"} aria-label="发送消息">↑</button>
              </form>
              <div className="composer-meta"><span>{activeRuntimeDetail || "Enter 发送，Shift + Enter 换行"}</span><span className={`node-state ${activeRuntimeReady ? "online" : ""}`}>{activeRuntimeReady ? `${activeRuntimeLabel} 可用` : activeClient?.online ? "Runtime 未就绪" : "Agent 离线"}</span></div>
            </div>
          </>
        ) : (
          <div className="welcome-state"><span className="welcome-mark">OC</span><h2>等待远程 Agent 连接</h2><p>连接后会自动出现在左侧列表中。</p></div>
        )}
      </section>
    </main>
  );
}
