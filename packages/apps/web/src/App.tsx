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

interface NotificationRecord {
  id: string;
  conversationId?: string;
  conversationTitle?: string;
  clientId?: string;
  runtime: string;
  type: "reply" | "completed" | "failed" | "file" | "system";
  origin: "controller" | "agent";
  title: string;
  text: string;
  prompt?: string;
  sessionKey?: string;
  from?: string;
  artifact?: AgentPushMessage["artifact"];
  timestamp: number;
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

const notificationTypeLabels: Record<NotificationRecord["type"], string> = {
  reply: "回复",
  completed: "完成",
  failed: "失败",
  file: "文件",
  system: "系统",
};

function notificationLevel(type: NotificationRecord["type"]): "success" | "error" | "warning" | "info" {
  if (type === "completed") return "success";
  if (type === "failed") return "error";
  if (type === "file") return "warning";
  return "info";
}

function formatBytes(size?: number): string {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function apiUrl(path: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function mergePushes(current: AgentPushMessage[], incoming: AgentPushMessage[]): AgentPushMessage[] {
  const byId = new Map(current.map((item) => [item.messageId, item]));
  for (const item of incoming) byId.set(item.messageId, item);
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), {
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
  const [showMessageCenter, setShowMessageCenter] = useState(false);
  const [selectedNotificationId, setSelectedNotificationId] = useState("");
  const [notificationRuntime, setNotificationRuntime] = useState("all");
  const [notificationType, setNotificationType] = useState("all");
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
  const notifications = useMemo<NotificationRecord[]>(() => {
    const records: NotificationRecord[] = [];
    for (const conversation of conversations) {
      for (const turn of conversation.turns) {
        const lastEvent = [...turn.events].reverse().find((event) => ["completed", "failed", "output"].includes(event.event));
        if (!lastEvent) continue;
        const failed = lastEvent.event === "failed";
        const completed = lastEvent.event === "completed";
        const text = failed ? errorForTurn(turn) : outputForTurn(turn);
        records.push({
          id: `turn:${conversation.id}:${turn.id}`,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          clientId: conversation.clientId,
          runtime: conversation.runtime,
          type: failed ? "failed" : completed ? "completed" : "reply",
          origin: "controller",
          title: failed ? "任务执行失败" : completed ? "任务已完成" : "Agent 回复",
          text: text || turn.prompt,
          prompt: turn.prompt,
          sessionKey: conversation.sessionKey,
          timestamp: lastEvent.timestamp || turn.createdAt,
        });
      }
    }
    for (const push of pushes) {
      const conversation = conversations.find((item) => item.sessionKey && item.sessionKey === push.sessionKey);
      records.push({
        id: `push:${push.messageId}`,
        conversationId: conversation?.id,
        conversationTitle: conversation?.title,
        clientId: conversation?.clientId,
        runtime: conversation?.runtime || push.from,
        type: push.artifact ? "file" : push.level === "error" ? "failed" : "system",
        origin: "agent",
        title: push.title || (push.artifact ? "文件已生成" : "平台通知"),
        text: push.text,
        sessionKey: push.sessionKey || conversation?.sessionKey,
        from: push.from,
        artifact: push.artifact,
        timestamp: push.timestamp,
      });
    }
    return records.sort((a, b) => b.timestamp - a.timestamp);
  }, [conversations, pushes]);
  const filteredNotifications = notifications.filter((item) =>
    (notificationRuntime === "all" || item.runtime === notificationRuntime)
    && (notificationType === "all" || item.type === notificationType));
  const selectedNotification = filteredNotifications.find((item) => item.id === selectedNotificationId)
    || filteredNotifications[0]
    || null;
  const notificationRuntimes = useMemo(() => {
    const labels = new Map<string, string>();
    for (const client of clients) {
      for (const runtime of runtimeOptions(client)) labels.set(runtime.id, runtime.label);
    }
    for (const item of notifications) {
      if (!labels.has(item.runtime)) labels.set(item.runtime, item.runtime);
    }
    return [...labels.entries()].map(([id, label]) => ({ id, label }));
  }, [clients, notifications]);

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

  function newConversation(clientId: string, runtime?: string): void {
    const client = clients.find((item) => item.id === clientId);
    const next = createConversation(clientId, runtime || defaultRuntime(client));
    setEmptyClientIds((current) => {
      const updated = new Set(current);
      updated.delete(clientId);
      return updated;
    });
    setConversations((current) => [next, ...current]);
    setExpandedClients((current) => new Set(current).add(clientId));
    setActiveId(next.id);
    setShowMessageCenter(false);
    setMessage("");
    setError("");
  }

  function selectRuntime(clientId: string, runtimeId: string): void {
    const existing = conversations
      .filter((conversation) => conversation.clientId === clientId && conversation.runtime === runtimeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) {
      setExpandedClients((current) => new Set(current).add(clientId));
      setActiveId(existing.id);
      setShowMessageCenter(false);
      return;
    }
    newConversation(clientId, runtimeId);
  }

  function openNotification(item: NotificationRecord): void {
    setSelectedNotificationId(item.id);
    setShowMessageCenter(true);
  }

  function toggleMessageCenter(): void {
    setShowMessageCenter((open) => {
      if (!open) setSelectedNotificationId((current) => current || notifications[0]?.id || "");
      return !open;
    });
  }

  function openNotificationConversation(item: NotificationRecord): void {
    if (!item.conversationId) return;
    const conversation = conversations.find((value) => value.id === item.conversationId);
    if (!conversation) return;
    setExpandedClients((current) => new Set(current).add(conversation.clientId));
    setActiveId(conversation.id);
    setShowMessageCenter(false);
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
    if (!clients.length || !activeId) return;
    const current = conversations.find((conversation) => conversation.id === activeId);
    if (current && clients.some((client) => client.id === current.clientId)) return;
    const fallback = conversations
      .filter((conversation) => clients.some((client) => client.id === conversation.clientId))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setActiveId(fallback?.id || "");
  }, [activeId, clients, conversations]);

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

    const source = new EventSource(apiUrl(`/api/tasks/${currentTaskId}/events`));
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
    let stopped = false;
    void json<AgentPushMessage[]>("/api/pushes")
      .then((items) => {
        if (!stopped) setPushes((current) => mergePushes(current, items));
      })
      .catch(() => undefined);
    const source = new EventSource(apiUrl("/api/events"));
    source.addEventListener("agent-push", (raw) => {
      const push = JSON.parse((raw as MessageEvent).data) as AgentPushMessage;
      setPushes((current) => mergePushes(current, [push]));
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
    return () => {
      stopped = true;
      source.close();
    };
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
        <section className="sidebar-message-center">
          <button className={`message-center-toggle ${showMessageCenter ? "active" : ""}`} type="button" onClick={toggleMessageCenter} aria-expanded={showMessageCenter}>
            <span aria-hidden="true">铃</span><strong>消息中心</strong><b>{notifications.length}</b><i aria-hidden="true">›</i>
          </button>
        </section>
        <nav className="agent-list" aria-label="远程 Agent 和对话">
          {clients.map((client) => {
            const clientConversations = conversations
              .filter((conversation) => conversation.clientId === client.id)
              .sort((a, b) => b.updatedAt - a.updatedAt);
            const runtimeList = runtimeOptions(client);
            const expanded = expandedClients.has(client.id);
            const ready = clientReady(client);
            return (
              <section className="agent-group" key={client.id}>
                <button className="agent-row" type="button" onClick={() => selectClient(client.id)}>
                  <span className="agent-avatar">{clientDisplayName(client).trim().slice(0, 1).toUpperCase()}</span>
                  <span className="agent-copy"><strong title={client.name}>{clientDisplayName(client)}</strong><small><span><i className={ready ? "online" : ""} />{ready ? "在线" : client.online ? "Runtime 未就绪" : "离线"}</span><b>{runtimeList.length} 个平台</b></small></span>
                  <span className={`chevron ${expanded ? "expanded" : ""}`} aria-hidden="true">›</span>
                </button>
                {expanded && (
                  <div className="platform-list">
                    {runtimeList.map((runtime) => {
                      const runtimeConversations = clientConversations.filter((conversation) => conversation.runtime === runtime.id);
                      const runtimeActive = active?.clientId === client.id && active.runtime === runtime.id;
                      return (
                        <div className={`platform-group ${runtimeActive ? "active" : ""}`} key={runtime.id}>
                          <button className="platform-row" type="button" onClick={() => selectRuntime(client.id, runtime.id)}>
                            <span className="platform-dot" aria-hidden="true" />
                            <span className="platform-copy"><strong>{runtime.label}</strong><small>{runtimeConversations.length} 个会话</small></span>
                            <span className={`platform-state ${runtime.ready === false ? "offline" : ""}`}>{runtime.ready === false ? "离线" : "在线"}</span>
                          </button>
                          {runtimeActive && <div className="conversation-list">
                            {runtimeConversations.map((conversation) => (
                              <div className={`conversation-item ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                                <button type="button" className="conversation-row" onClick={() => { setActiveId(conversation.id); setShowMessageCenter(false); }} title={conversation.title}>
                                  <span aria-hidden="true">▱</span><span>{conversation.title}</span>
                                </button>
                                <button className="delete-chat" type="button" onClick={() => deleteConversation(conversation.id)} disabled={conversation.id === activeId && busy} title={conversation.id === activeId && busy ? "请先停止当前回复" : "删除对话"} aria-label={`删除对话 ${conversation.title}`}>×</button>
                              </div>
                            ))}
                            <button className="new-chat-inline" type="button" onClick={() => newConversation(client.id, runtime.id)}><span aria-hidden="true">＋</span> 新对话</button>
                          </div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          {clients.length === 0 && <div className="no-agents">正在查找远程 Agent...</div>}
        </nav>
        <div className="sidebar-footer"><span className={`hub-dot ${connection}`} />控制服务 {connection === "connected" ? "已连接" : "连接中"}</div>
      </aside>

      <section className={`chat-workspace ${showMessageCenter ? "with-inbox" : ""}`}>
        {showMessageCenter ? (
          <>
            <aside className="inbox-pane">
              <header className="inbox-header">
                <strong>消息中心</strong>
                <span>{filteredNotifications.length} 条</span>
              </header>
              <div className="message-center-list">
                <div className="message-center-counts">
                  <span>全部 <b>{notifications.length}</b></span>
                  <span>完成 <b>{notifications.filter((item) => item.type === "completed").length}</b></span>
                  <span>失败 <b>{notifications.filter((item) => item.type === "failed").length}</b></span>
                </div>
                <div className="message-center-filters">
                  <select aria-label="消息中心按平台筛选" value={notificationRuntime} onChange={(event) => setNotificationRuntime(event.target.value)}>
                    <option value="all">全部平台</option>
                    {notificationRuntimes.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.label}</option>)}
                  </select>
                  <select aria-label="消息中心按类型筛选" value={notificationType} onChange={(event) => setNotificationType(event.target.value)}>
                    <option value="all">全部类型</option>
                    <option value="reply">回复</option>
                    <option value="completed">完成</option>
                    <option value="failed">失败</option>
                    <option value="file">文件</option>
                    <option value="system">系统</option>
                  </select>
                </div>
                <div className="message-center-items">
                  {filteredNotifications.length === 0
                    ? <p>暂无符合条件的消息</p>
                    : filteredNotifications.map((item) => (
                      <button
                        className={`message-center-item ${item.origin} ${selectedNotification?.id === item.id ? "selected" : ""}`}
                        type="button"
                        key={item.id}
                        onClick={() => openNotification(item)}
                        aria-current={selectedNotification?.id === item.id ? "true" : undefined}
                      >
                        <span className={`push-level ${notificationLevel(item.type)}`} />
                        <span>
                          <strong>{item.title}<em>{item.origin === "controller" ? "主控任务" : "Agent 回传"}</em></strong>
                          <small>{item.text}</small>
                          <time>{item.runtime} · {new Date(item.timestamp).toLocaleString()}</time>
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            </aside>
            <section className="notification-detail" aria-live="polite">
              {selectedNotification ? (
                <>
                  <header className="notification-detail-header">
                    <div>
                      <h1>{selectedNotification.title}</h1>
                      <p>
                        {selectedNotification.origin === "controller" ? "主控任务" : "Agent 回传"}
                        · {notificationTypeLabels[selectedNotification.type]}
                        · {selectedNotification.runtime}
                      </p>
                    </div>
                    {selectedNotification.conversationId && (
                      <button className="new-chat-button" type="button" onClick={() => openNotificationConversation(selectedNotification)}>打开对话</button>
                    )}
                  </header>
                  <dl className="notification-detail-meta">
                    <div><dt>时间</dt><dd>{new Date(selectedNotification.timestamp).toLocaleString()}</dd></div>
                    <div><dt>来源</dt><dd>{selectedNotification.origin === "controller" ? "主控任务" : selectedNotification.from || "Agent 回传"}</dd></div>
                    {selectedNotification.conversationTitle && <div><dt>对话</dt><dd>{selectedNotification.conversationTitle}</dd></div>}
                    {selectedNotification.sessionKey && <div><dt>会话</dt><dd><code>{selectedNotification.sessionKey}</code></dd></div>}
                  </dl>
                  <div className="notification-detail-body">
                    {selectedNotification.prompt && selectedNotification.prompt !== selectedNotification.text && (
                      <section>
                        <h2>原始指令</h2>
                        <pre>{selectedNotification.prompt}</pre>
                      </section>
                    )}
                    <section>
                      <h2>消息内容</h2>
                      <pre>{selectedNotification.text || "没有文本内容"}</pre>
                    </section>
                    {selectedNotification.artifact && (
                      <section>
                        <h2>附件</h2>
                        <a href={selectedNotification.artifact.url} target="_blank" rel="noreferrer">
                          {selectedNotification.artifact.name}
                          {selectedNotification.artifact.size ? ` · ${formatBytes(selectedNotification.artifact.size)}` : ""}
                        </a>
                      </section>
                    )}
                  </div>
                </>
              ) : (
                <div className="welcome-state">
                  <span className="welcome-mark">铃</span>
                  <h2>选择一条消息</h2>
                  <p>点击左侧列表查看完整内容和附件。</p>
                </div>
              )}
            </section>
          </>
        ) : active ? (
          <>
            <header className="chat-header">
              <div className="chat-identity">
                <span className="header-avatar">{activeClientName.trim().slice(0, 1).toUpperCase() || "?"}</span>
                <div><h1>{active.title}</h1><p title={activeClient?.name}>{activeClientName} · {active.runtime} · Agent {active.agentId}</p></div>
              </div>
              <div className="header-actions">
                {busy && <button className="icon-button danger" type="button" onClick={cancel} title="停止当前回复" aria-label="停止当前回复">■</button>}
                <button className="new-chat-button" type="button" onClick={() => newConversation(active.clientId, active.runtime)}><span aria-hidden="true">＋</span> 新对话</button>
              </div>
            </header>

            <div className="session-banner" title="这个标识同时用于远端智能体的 sessionKey">
              <span className="breadcrumb">{activeClientName} <b>›</b> {activeRuntimeLabel} <b>›</b> {active.title}</span>
              <span className="session-lock">会话固定于当前平台</span>
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
