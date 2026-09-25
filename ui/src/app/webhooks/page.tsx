"use client";

import Nav from "@/components/Nav";
import { FormEvent, useEffect, useState } from "react";

type Webhook = { id: string; url: string; eventTypes: string[]; active: boolean };

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [eventTypes, setEventTypes] = useState("*");
  const [message, setMessage] = useState("");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";
  const token = () => localStorage.getItem("admin_token") ?? "";

  const load = async () => {
    const response = await fetch(`${apiUrl}/v1/webhooks`, { headers: { Authorization: `Bearer ${token()}` } });
    if (response.ok) setWebhooks((await response.json()).data ?? []);
  };

  useEffect(() => { void load(); }, []);

  const register = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiUrl}/v1/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ url, secret, eventTypes: eventTypes.split(",").map((type) => type.trim()).filter(Boolean) }),
    });
    setMessage(response.ok ? "Webhook registered" : await response.text());
    if (response.ok) { setUrl(""); setSecret(""); await load(); }
  };

  const test = async (id: string) => {
    const response = await fetch(`${apiUrl}/v1/webhooks/${id}/test`, { method: "POST", headers: { Authorization: `Bearer ${token()}` } });
    setMessage(response.ok ? "Test delivered" : await response.text());
  };

  return (
    <>
      <Nav />
      <main id="main-content" className="container" style={{ padding: "32px 24px" }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>Webhook Management</h1>
        <p style={{ marginBottom: 16 }}>Register HMAC-signed event endpoints and send a test delivery.</p>
        <form onSubmit={register} style={{ display: "grid", gap: 10, maxWidth: 560, marginBottom: 24 }}>
          <input required type="url" placeholder="https://example.com/events" value={url} onChange={(event) => setUrl(event.target.value)} />
          <input required type="password" minLength={16} placeholder="Signing secret (16+ characters)" value={secret} onChange={(event) => setSecret(event.target.value)} />
          <input placeholder="Event types, comma separated (* for all)" value={eventTypes} onChange={(event) => setEventTypes(event.target.value)} />
          <button type="submit">Register webhook</button>
        </form>
        {message && <p role="status">{message}</p>}
        {webhooks.map((webhook) => (
          <div key={webhook.id} style={{ borderTop: "1px solid var(--border)", padding: "12px 0", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span>{webhook.url} ({webhook.eventTypes.join(", ")})</span>
            <button type="button" onClick={() => test(webhook.id)}>Send test</button>
          </div>
        ))}
      </main>
    </>
  );
}
