// Vercel Function: the form in src/components/Contact.astro posts here; mail goes out via Resend.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (body, status = 200) => Response.json(body, { status });

export async function POST(request) {
  let name, email, message;
  try {
    ({ name, email, message } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  if (!name || !email || !message || !/^\S+@\S+\.\S+$/.test(email) || String(message).length > 5000) {
    return json({ error: 'Name, a valid email and message are required.' }, 400);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return json({ error: 'RESEND_API_KEY not configured.' }, 500);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'Contacto Portafolio <contacto@jhongdlp.com>',
      to: 'hello@jhongdlp.com',
      reply_to: email,
      subject: `Nuevo mensaje de ${String(name).slice(0, 100)} (Portafolio)`,
      html: `<div style="font-family:system-ui,sans-serif;padding:24px">
        <h2>Nuevo mensaje del portafolio</h2>
        <p><strong>Nombre:</strong> ${esc(name)}</p>
        <p><strong>Email:</strong> ${esc(email)}</p>
        <p><strong>Mensaje:</strong></p>
        <div style="white-space:pre-wrap">${esc(message)}</div>
      </div>`,
    }),
  });

  if (!res.ok) {
    console.error('Resend error:', await res.text());
    return json({ error: 'Failed to send email.' }, 502);
  }
  return json({ success: true });
}
