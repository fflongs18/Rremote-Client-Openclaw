import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Status = "idle" | "pending" | "started" | "in_progress" | "completed" | "failed" | "cancelled";

interface Client {
  id: string;
  name: string;
  runtime: string;
  connectedAt: number | null;
  online: boolean;
}

interface TaskEvent {
  taskId: string;
  sequence: number;
  event: string;
  runId?: string;
  data?: { text?: string };
  timestamp: number;
}

const terminal = new Set<Status>(["completed", "failed", "cancelled"]);

function statusFromEvent(event: string): Status | null {
  if (event === "accepted") return "started";
  if (["started", "output", "tool_use", "tool_result", "turn_done"].includes(event)) return "in_progress";
  if (["completed", "failed", "cancelled"].includes(event)) return event as Status;
  return null;
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
  const [clientId, setClientId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [sessionKey, setSessionKey] = useState("");
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState(() => localStorage.getItem("remote-oc:last-task") || "");
  const [status, setStatus] = useState<Status>("idle");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [error, setError] = useState("");
  const eventSource = useRef<EventSource | null>(null);

  const output = useMemo(
    () => events.filter((event) => event.event === "output").map((event) => event.data?.text || "").join(""),
    [events],
  );

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await json<Client[]>("/api/clients");
        if (stopped) return;
        setClients(next);
        setClientId((current) => current && next.some((client) => client.id === current) ? current : next[0]?.id || "");
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!taskId) return;
    localStorage.setItem("remote-oc:last-task", taskId);
    let stopped = false;
    void json<{ task: { status: Status }; events: TaskEvent[] }>(`/api/tasks/${taskId}`)
      .then((result) => {
        if (stopped) return;
        setStatus(result.task.status);
        // Merge by sequence so a late history fetch cannot wipe SSE events
        // or reintroduce duplicates when SSE already replayed the same rows.
        setEvents((current) => {
          const bySequence = new Map(current.map((item) => [item.sequence, item]));
          for (const item of result.events) bySequence.set(item.sequence, item);
          return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
        });
      })
      .catch((cause) => !stopped && setError(cause instanceof Error ? cause.message : String(cause)));

    eventSource.current?.close();
    const source = new EventSource(`/api/tasks/${taskId}/events`);
    eventSource.current = source;
    setConnection("connecting");
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("reconnecting");
    source.addEventListener("task-event", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as TaskEvent;
      setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event].sort((a, b) => a.sequence - b.sequence));
      const nextStatus = statusFromEvent(event.event);
      if (nextStatus) setStatus(nextStatus);
    });
    return () => {
      stopped = true;
      source.close();
    };
  }, [taskId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!clientId || !message.trim()) return;
    setError("");
    setEvents([]);
    setStatus("pending");
    try {
      const result = await json<{ taskId: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ clientId, message, agentId, sessionKey }),
      });
      setTaskId(result.taskId);
    } catch (cause) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function cancel() {
    if (!taskId) return;
    try {
      await json(`/api/tasks/${taskId}/cancel`, { method: "POST", body: "{}" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">DISTRIBUTED OPENCLAW</p>
          <h1>Remote Control</h1>
        </div>
        <div className={`connection ${connection}`}><span />{connection}</div>
      </header>

      <section className="layout">
        <form className="panel composer" onSubmit={submit}>
          <div className="panel-title"><span>01</span><h2>选择执行节点</h2></div>
          <label>电脑</label>
          <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
            {clients.length === 0 && <option value="">没有在线 Remote Client</option>}
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name} · {client.id}</option>)}
          </select>
          <div className="two-columns">
            <div><label>Agent ID（可选）</label><input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="main" /></div>
            <div><label>Session Key（可选）</label><input value={sessionKey} onChange={(event) => setSessionKey(event.target.value)} placeholder="自动创建" /></div>
          </div>
          <label>发送给 OpenClaw</label>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="让远端电脑上的 OpenClaw 执行任务…" rows={8} />
          <button className="primary" disabled={!clientId || !message.trim() || (!terminal.has(status) && status !== "idle")}>发送任务 <span>↗</span></button>
        </form>

        <section className="panel run">
          <div className="panel-title"><span>02</span><h2>执行过程</h2><b className={`status ${status}`}>{status}</b></div>
          <div className="task-id">{taskId || "尚未创建任务"}</div>
          {error && <div className="error">{error}</div>}
          <div className="output">
            {output ? <pre>{output}</pre> : <div className="empty">流式输出会显示在这里</div>}
          </div>
          <div className="timeline">
            {events.filter((event) => event.event !== "output").map((event) => (
              <article key={event.sequence}>
                <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                <strong>{event.event}</strong>
                {event.data?.text && <p>{event.data.text}</p>}
              </article>
            ))}
          </div>
          <button className="cancel" disabled={!taskId || status === "idle" || terminal.has(status)} onClick={cancel}>取消当前任务</button>
        </section>
      </section>
    </main>
  );
}
