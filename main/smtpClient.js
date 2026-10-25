'use strict';

/**
 * SMTP verify/send from the desktop app.
 * Render (and many cloud hosts) block outbound 465/587; this PC can reach Gmail.
 */
const net = require('net');
const tls = require('tls');
const dns = require('dns');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Node < 17
}

function smtpLog(...args) {
  console.log('[DESK SMTP]', ...args);
}

function readResponse(socket, ms = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      const err = new Error('SMTP timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buf });
      }
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
    };
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

function writeLine(socket, line) {
  socket.write(`${line}\r\n`);
}

function connectSocket({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('SMTP connection timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, 15000);
    const onConnect = (socket) => {
      clearTimeout(timer);
      resolve(socket);
    };
    const sock = secure
      ? tls.connect({ host, port: Number(port), servername: host, rejectUnauthorized: false }, () =>
          onConnect(sock)
        )
      : net.connect({ host, port: Number(port) }, () => onConnect(sock));
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function startTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: host, rejectUnauthorized: false },
      () => resolve(secure)
    );
    secure.once('error', reject);
  });
}

async function smtpSession(config, afterAuth) {
  const host = String(config.host || '').trim();
  const port = Number(config.port) || (config.secure ? 465 : 587);
  const secure = Boolean(config.secure) || port === 465;
  const user = String(config.user || config.email || '').trim();
  const pass = String(config.pass || config.password || '').replace(/\s+/g, '');
  if (!host || !user || !pass) throw new Error('SMTP host, username, and password are required');

  smtpLog('session', `${host}:${port}${secure ? '/SSL' : '/STARTTLS'} user=${user} passLen=${pass.length}`);
  let socket = await connectSocket({ host, port, secure });
  socket.setEncoding('utf8');

  const greet = await readResponse(socket);
  if (greet.code !== 220) throw new Error(greet.text.trim() || 'SMTP greeting failed');

  writeLine(socket, `EHLO datdesk`);
  let ehlo = await readResponse(socket);
  if (ehlo.code !== 250) throw new Error(ehlo.text.trim() || 'EHLO failed');

  if (!secure) {
    writeLine(socket, 'STARTTLS');
    const tlsRes = await readResponse(socket);
    if (tlsRes.code !== 220) throw new Error(tlsRes.text.trim() || 'STARTTLS failed');
    socket = await startTls(socket, host);
    socket.setEncoding('utf8');
    writeLine(socket, `EHLO datdesk`);
    ehlo = await readResponse(socket);
    if (ehlo.code !== 250) throw new Error(ehlo.text.trim() || 'EHLO after STARTTLS failed');
  }

  writeLine(socket, 'AUTH LOGIN');
  const authStart = await readResponse(socket);
  if (authStart.code !== 334) throw new Error(authStart.text.trim() || 'AUTH LOGIN not accepted');
  writeLine(socket, Buffer.from(user, 'utf8').toString('base64'));
  const userRes = await readResponse(socket);
  if (userRes.code !== 334) throw new Error(userRes.text.trim() || 'SMTP username rejected');
  writeLine(socket, Buffer.from(pass, 'utf8').toString('base64'));
  const passRes = await readResponse(socket);
  if (passRes.code !== 235) {
    const err = new Error('SMTP login failed. For Gmail use an App Password.');
    err.code = 'SMTP_AUTH';
    throw err;
  }

  smtpLog('auth ok', user);
  let result = { ok: true };
  if (typeof afterAuth === 'function') {
    result = (await afterAuth(socket)) || result;
  }

  try {
    writeLine(socket, 'QUIT');
    await readResponse(socket, 5000);
  } catch {
    // ignore
  }
  try {
    socket.end();
  } catch {
    // ignore
  }
  return result;
}

async function verifySmtp(config) {
  try {
    await smtpSession(config);
    return { ok: true };
  } catch (err) {
    smtpLog('verify fail', err.code || '', err.message || err);
    return { ok: false, message: err.message || 'SMTP verify failed', code: err.code || '' };
  }
}

function quoteAddr(value) {
  const s = String(value || '').trim();
  const m = s.match(/<([^>]+)>/);
  return m ? m[1] : s;
}

function wrapBase64(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const lines = [];
  for (let i = 0; i < clean.length; i += 76) lines.push(clean.slice(i, i + 76));
  return lines.join('\r\n');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function buildMimePayload(config) {
  const from = config.from || quoteAddr(config.user || config.email);
  const to = quoteAddr(config.to);
  const cc = String(config.cc || '').trim();
  const subject = String(config.subject || '');
  const html = String(config.bodyHtml || '').trim() || (/<[a-z]/i.test(config.body) ? config.body : '');
  const text = html ? stripHtml(html) : String(config.body || config.text || '');
  const attachments = Array.isArray(config.attachments) ? config.attachments : [];

  if (!attachments.length) {
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      html
        ? 'Content-Type: text/html; charset=utf-8'
        : 'Content-Type: text/plain; charset=utf-8',
      '',
      (html || text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
      '.'
    ].filter(Boolean);
    return headers.join('\r\n');
  }

  const boundary = 'Signal_' + Date.now().toString(36);
  const altBoundary = boundary + '_alt';
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    (html || text.replace(/\n/g, '<br>')).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    '',
    `--${altBoundary}--`
  ].filter((l) => l != null);

  for (const file of attachments) {
    const filename = String(file.filename || file.name || 'attachment');
    const contentType = String(file.contentType || file.type || 'application/octet-stream');
    const content = String(file.content || '').replace(/^data:[^;]+;base64,/, '');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      wrapBase64(content),
      ''
    );
  }
  lines.push(`--${boundary}--`, '.');
  return lines.join('\r\n');
}

async function sendSmtp(config) {
  const from = quoteAddr(config.from || config.user || config.email);
  const to = quoteAddr(config.to);
  const subject = String(config.subject || '');
  const body = String(config.body || config.text || '');
  const bodyHtml = String(config.bodyHtml || '');
  if (!to || !subject || !(body.trim() || bodyHtml.trim())) {
    return { ok: false, message: 'To, subject, and body are required' };
  }
  try {
    const result = await smtpSession(config, async (socket) => {
      writeLine(socket, `MAIL FROM:<${from}>`);
      const mailFrom = await readResponse(socket);
      if (mailFrom.code !== 250) throw new Error(mailFrom.text.trim() || 'MAIL FROM failed');
      writeLine(socket, `RCPT TO:<${to}>`);
      const rcpt = await readResponse(socket);
      if (rcpt.code !== 250 && rcpt.code !== 251) throw new Error(rcpt.text.trim() || 'RCPT TO failed');
      const extraRcpt = [config.cc, config.bcc]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join(',');
      if (extraRcpt) {
        for (const addr of extraRcpt.split(/[,;]+/).map((a) => quoteAddr(a)).filter(Boolean)) {
          writeLine(socket, `RCPT TO:<${addr}>`);
          const extraRes = await readResponse(socket);
          if (extraRes.code !== 250 && extraRes.code !== 251) {
            throw new Error(extraRes.text.trim() || 'RCPT TO failed');
          }
        }
      }
      writeLine(socket, 'DATA');
      const dataRes = await readResponse(socket);
      if (dataRes.code !== 354) throw new Error(dataRes.text.trim() || 'DATA not accepted');
      const payload = buildMimePayload(config);
      socket.write(`${payload}\r\n`);
      const done = await readResponse(socket);
      if (done.code !== 250) throw new Error(done.text.trim() || 'Message rejected');
      smtpLog('send ok', to);
      return { ok: true, messageId: done.text.trim() };
    });
    return result;
  } catch (err) {
    smtpLog('send fail', err.message || err);
    return { ok: false, message: err.message || 'SMTP send failed', code: err.code || '' };
  }
}

module.exports = { verifySmtp, sendSmtp };
