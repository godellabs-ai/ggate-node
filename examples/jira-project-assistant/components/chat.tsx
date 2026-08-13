"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Loader2, ShieldX, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScanTrail, VerdictPill, type ScanRecord } from "@/components/scan-badges";
import { ThemeToggle } from "@/components/theme-toggle";

interface BlockedInfo {
  label: string;
  surface: string;
  detection?: { source: string; detail: string };
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  scans?: ScanRecord[];
  blocked?: BlockedInfo;
}

const SUGGESTIONS = [
  "Describe the ticket ECS-55",
  "Show all in progress tasks",
  "Which tickets are unassigned?",
];

const SOURCE_LABEL: Record<string, string> = {
  ioc: "IOC",
  security_classification: "Security classification",
  data_authority: "Data authority",
  sensitive_data: "Sensitive data",
  detection_rule: "Detection rule",
  organization_policy: "Organization policy",
};

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const sessionId = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionId.current = crypto.randomUUID();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;
    setInput("");
    setMessages((prior) => [...prior, { role: "user", text: message }]);
    setPending(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, sessionId: sessionId.current }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setMessages((prior) => [
        ...prior,
        { role: "assistant", text: data.reply ?? "", scans: data.scans, blocked: data.blocked },
      ]);
    } catch (error) {
      setMessages((prior) => [
        ...prior,
        { role: "assistant", text: `Something went wrong: ${error instanceof Error ? error.message : error}` },
      ]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between border-b border-border/10 bg-card/95 px-5 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Ticket className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight md:text-xl">Jira Project Assistant</h1>
            <p className="text-xs text-muted-foreground">
              Every prompt, tool call, and attachment scanned by{" "}
              <span className="font-semibold text-primary">Gödel&apos;s Gate</span>
            </p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <div ref={scrollRef} className="custom-scrollbar flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.length === 0 && !pending && (
            <div className="mt-16 flex flex-col items-center gap-6 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Ticket className="size-7" />
              </div>
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Ask about your Jira projects</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Tickets, sprints, boards — answered live from Jira, guarded end to end.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    className="card-surface card-surface-hover px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) =>
            message.role === "user" ? (
              <div key={index} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-sm">
                  {message.text}
                </div>
              </div>
            ) : (
              <div key={index} className="flex flex-col items-start">
                {message.blocked ? (
                  <BlockedCard blocked={message.blocked} />
                ) : (
                  <div className="card-surface max-w-[92%] px-4 py-3 text-sm leading-relaxed">
                    <div className="prose-chat">
                      <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                    </div>
                  </div>
                )}
                {message.scans && <ScanTrail scans={message.scans} />}
              </div>
            ),
          )}

          {pending && (
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="animate-pulse">Scanning &amp; thinking…</span>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border/10 bg-card/95 px-4 py-4 backdrop-blur">
        <form
          className="mx-auto flex max-w-3xl items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder='Ask about a ticket, e.g. "Describe the ticket ECS-55"'
            disabled={pending}
            className="h-11 w-full rounded-lg border border-border bg-card px-4 text-sm font-medium shadow-sm outline-none transition-all placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-primary text-white shadow-sm transition-all",
              "hover:bg-primary/90 active:translate-x-[1px] active:translate-y-[1px] active:shadow-none",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
            aria-label="Send"
          >
            <ArrowUp className="size-5" />
          </button>
        </form>
      </div>
    </div>
  );
}

function BlockedCard({ blocked }: { blocked: BlockedInfo }) {
  return (
    <div className="max-w-[92%] rounded-xl border border-red-300 bg-red-50 px-4 py-3 shadow-sm dark:border-red-900 dark:bg-red-950/40">
      <div className="flex items-center gap-2">
        <ShieldX className="size-4 text-red-600 dark:text-red-400" />
        <span className="text-sm font-bold text-red-700 dark:text-red-300">
          Chat blocked by Gödel&apos;s Gate
        </span>
        <VerdictPill verdict="block" />
      </div>
      <p className="mt-1.5 text-sm text-red-700/90 dark:text-red-300/90">
        {blocked.detection
          ? `${SOURCE_LABEL[blocked.detection.source] ?? blocked.detection.source}: ${blocked.detection.detail}`
          : "A protection fired while handling this request."}
        <span className="text-red-700/60 dark:text-red-300/60">
          {" "}
          (on {blocked.surface.replace("_", " ")}: {blocked.label})
        </span>
      </p>
    </div>
  );
}
