/**
 * Deterministic synthetic Gmail API messages shaped like a real inbox page:
 * newsletters and notifications with a plain-text and an HTML part, short
 * personal mail with quoted replies, HTML-only marketing with invisible
 * preheader padding, and mail with a PDF attachment. Each message carries a
 * realistic root header set (Received chain, DKIM, ARC, authentication
 * results, list headers).
 */
type Part = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Array<{ name: string; value: string }>;
  body: { size: number; data?: string; attachmentId?: string };
  parts?: Part[];
};

export type SyntheticGmailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  sizeEstimate: number;
  payload: Part;
};

const WORDS =
  "account update review meeting project invoice payment schedule weekly report team product release security notice order shipping delivery confirm subscription offer member event webinar draft budget quarter customer support ticket feedback design launch roadmap travel booking receipt statement balance reminder deadline contract proposal".split(
    " ",
  );

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function prose(random: () => number, chars: number): string {
  const paragraphs: string[] = [];
  let length = 0;
  while (length < chars) {
    const sentences: string[] = [];
    const count = 3 + Math.floor(random() * 4);
    for (let s = 0; s < count; s += 1) {
      const words = Array.from(
        { length: 8 + Math.floor(random() * 12) },
        () => WORDS[Math.floor(random() * WORDS.length)]!,
      );
      const sentence = words.join(" ");
      sentences.push(`${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`);
    }
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join("\n\n").slice(0, chars);
}

function htmlFor(random: () => number, text: string, targetChars: number, preheader: boolean) {
  const style =
    "font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#333333;padding:0 24px 16px 24px";
  const head = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Newsletter</title><style>${".c{margin:0;padding:0}".repeat(40)}</style></head><body style="margin:0;padding:0;background:#f4f4f4">`;
  const padding = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden">Your weekly picks are here${"\u034f \u200c ".repeat(120)}</div>`
    : "";
  const rows = text
    .split("\n\n")
    .map(
      (paragraph, index) =>
        `<tr><td class="c" style="${style}"><p style="margin:0">${paragraph}</p>${
          index % 2 === 0
            ? `<a href="https://click.example.test/t/${Math.floor(random() * 1e12).toString(36)}/${"x".repeat(120)}" style="color:#1a73e8;text-decoration:underline">Read more &rarr;</a>`
            : ""
        }</td></tr>`,
    )
    .join("");
  let html = `${head}${padding}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${rows}</tbody></table>`;
  while (html.length < targetChars) {
    html += `<table role="presentation" width="100%"><tr><td style="${style}">&nbsp;</td></tr></table><!-- spacer ${Math.floor(random() * 1e9)} -->`;
  }
  return `${html}<p style="font-size:12px;color:#999">You are receiving this because you subscribed. <a href="https://example.test/unsubscribe">Unsubscribe</a></p></body></html>`;
}

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

function textPart(partId: string, mimeType: string, text: string): Part {
  return {
    partId,
    mimeType,
    filename: "",
    headers: [
      { name: "Content-Type", value: `${mimeType}; charset="UTF-8"` },
      { name: "Content-Transfer-Encoding", value: "quoted-printable" },
    ],
    body: { size: Buffer.byteLength(text), data: b64(text) },
  };
}

function rootHeaders(
  random: () => number,
  index: number,
  from: string,
  subject: string,
  date: Date,
  bulk: boolean,
) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789+/";
  const token = () =>
    Array.from({ length: 64 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  const when = date.toUTCString();
  const seconds = Math.floor(date.getTime() / 1000);
  const received = Array.from({ length: 4 }, (_, hop) => ({
    name: "Received",
    value: `from mail-relay${hop}.example.test (mail-relay${hop}.example.test. [192.0.2.${hop + 10}]) by mx.example.test with ESMTPS id ${token().slice(0, 24)} for <owner@example.test> (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256); ${when}`,
  }));
  const signature = () => `${token()}${token()}${token()}${token()}`;
  return [
    { name: "Delivered-To", value: "owner@example.test" },
    ...received,
    { name: "X-Google-Smtp-Source", value: `${token()}${token()}` },
    {
      name: "X-Received",
      value: `by 2002:a05:6000:${index}::${index} with SMTP id ${token().slice(0, 30)}; ${when}`,
    },
    {
      name: "ARC-Seal",
      value: `i=1; a=rsa-sha256; t=${seconds}; cv=none; d=google.com; s=arc-20240605; b=${signature()}`,
    },
    {
      name: "ARC-Message-Signature",
      value: `i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605; h=list-unsubscribe:mime-version:subject:message-id:to:from:date:dkim-signature; bh=${token()}; b=${signature()}`,
    },
    {
      name: "ARC-Authentication-Results",
      value: `i=1; mx.google.com; dkim=pass header.i=@example.test header.s=s1 header.b=${token().slice(0, 8)}; spf=pass (google.com: domain of bounce@example.test designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@example.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.test`,
    },
    { name: "Return-Path", value: "<bounce@example.test>" },
    {
      name: "Received-SPF",
      value:
        "pass (google.com: domain of bounce@example.test designates 192.0.2.10 as permitted sender) client-ip=192.0.2.10;",
    },
    {
      name: "Authentication-Results",
      value: `mx.google.com; dkim=pass header.i=@example.test header.s=s1 header.b=${token().slice(0, 8)}; spf=pass smtp.mailfrom=bounce@example.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.test`,
    },
    {
      name: "DKIM-Signature",
      value: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.test; s=s1; t=${seconds}; h=from:to:subject:date:message-id:list-unsubscribe; bh=${token()}; b=${signature()}`,
    },
    { name: "From", value: from },
    { name: "To", value: "Owner <owner@example.test>" },
    ...(index % 7 === 0 ? [{ name: "Cc", value: "Team <team@example.test>" }] : []),
    { name: "Subject", value: subject },
    { name: "Date", value: when },
    { name: "Message-ID", value: `<${token().slice(0, 32)}@example.test>` },
    { name: "MIME-Version", value: "1.0" },
    ...(bulk
      ? [
          {
            name: "List-Unsubscribe",
            value: `<https://example.test/unsubscribe/${token()}>, <mailto:unsubscribe@example.test?subject=${token().slice(0, 20)}>`,
          },
          { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
          { name: "Reply-To", value: "Support <support@example.test>" },
          { name: "Precedence", value: "bulk" },
          { name: "X-Campaign-Id", value: token().slice(0, 40) },
          { name: "Feedback-ID", value: `${index}:campaign:example:${token().slice(0, 16)}` },
        ]
      : []),
  ];
}

type Kind = "newsletter" | "notification" | "personal" | "marketing" | "attachment";
const TEXT_CHARS: Record<Kind, number> = {
  newsletter: 5_000,
  notification: 1_500,
  personal: 900,
  marketing: 3_000,
  attachment: 700,
};
const HTML_CHARS: Record<Kind, number> = {
  newsletter: 30_000,
  notification: 12_000,
  personal: 2_000,
  marketing: 45_000,
  attachment: 1_500,
};
const SENDERS: Record<Kind, string> = {
  newsletter: "Product Weekly <news@example.test>",
  notification: "Service Alerts <alerts@example.test>",
  personal: "Alex Example <alex@example.test>",
  marketing: "Store <offers@example.test>",
  attachment: "Billing <billing@example.test>",
};

function kindAt(index: number): Kind {
  const slot = index % 10;
  if (slot < 4) return "newsletter";
  if (slot < 7) return "notification";
  if (slot === 7) return "personal";
  if (slot === 8) return "marketing";
  return "attachment";
}

/** One realistic inbox page of `count` full-format Gmail API messages. */
export function syntheticInboxPage(count = 50, seed = 7): SyntheticGmailMessage[] {
  const random = seeded(seed);
  const start = Date.UTC(2026, 9, 24, 18, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start - index * 47 * 60_000);
    const kind = kindAt(index);
    const subject =
      kind === "attachment"
        ? `Invoice ${1000 + index} for October`
        : `${kind === "personal" ? "Re: " : ""}${prose(random, 45)}`;
    const from = SENDERS[kind];
    const text = prose(random, TEXT_CHARS[kind]);
    const quoted =
      kind === "personal"
        ? `\n\nOn ${date.toUTCString()} Owner <owner@example.test> wrote:\n${prose(random, 2_500)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}`
        : "";
    const plain = `${text}${quoted}`;
    const html = htmlFor(random, plain, HTML_CHARS[kind], kind === "marketing");
    const nested = kind === "attachment";
    const alternative: Part =
      kind === "marketing"
        ? textPart("", "text/html", html)
        : {
            partId: nested ? "0" : "",
            mimeType: "multipart/alternative",
            filename: "",
            headers: [{ name: "Content-Type", value: 'multipart/alternative; boundary="000000"' }],
            body: { size: 0 },
            parts: [
              textPart(nested ? "0.0" : "0", "text/plain", plain),
              textPart(nested ? "0.1" : "1", "text/html", html),
            ],
          };
    const headers = rootHeaders(random, index, from, subject, date, kind !== "personal" && !nested);
    const payload: Part = nested
      ? {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers,
          body: { size: 0 },
          parts: [
            alternative,
            {
              partId: "1",
              mimeType: "application/pdf",
              filename: `invoice-${1000 + index}.pdf`,
              headers: [
                {
                  name: "Content-Type",
                  value: `application/pdf; name="invoice-${1000 + index}.pdf"`,
                },
                {
                  name: "Content-Disposition",
                  value: `attachment; filename="invoice-${1000 + index}.pdf"`,
                },
              ],
              body: { size: 48_213, attachmentId: `ANGjdJ${"a".repeat(300)}${index}` },
            },
          ],
        }
      : { ...alternative, headers: [...headers, ...alternative.headers] };
    const id = `19a${(0x1000 + index).toString(16)}f00d${index}`;
    return {
      id,
      threadId: id,
      labelIds:
        kind === "personal"
          ? ["IMPORTANT", "CATEGORY_PERSONAL", "INBOX", "UNREAD"]
          : ["CATEGORY_UPDATES", "INBOX", ...(index % 3 === 0 ? ["UNREAD"] : [])],
      snippet: plain.slice(0, 180).replaceAll("\n", " "),
      historyId: String(9_000_000 + index),
      internalDate: String(date.getTime()),
      sizeEstimate: Buffer.byteLength(plain) + Buffer.byteLength(html) + 8_000,
      payload,
    };
  });
}

/** A Gmail fetch fake serving search, message and thread reads from one page. */
export function syntheticGmailFetch(messages: SyntheticGmailMessage[]): typeof fetch {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const segments = url.pathname.split("/");
    const last = decodeURIComponent(segments.at(-1)!);
    if (url.pathname.endsWith("/messages")) {
      const max = Number(url.searchParams.get("maxResults") ?? "100");
      return Response.json({
        messages: messages.slice(0, max).map(({ id, threadId }) => ({ id, threadId })),
        nextPageToken: "next-page",
        resultSizeEstimate: 201,
      });
    }
    if (segments.at(-2) === "messages" && byId.has(last)) {
      return Response.json(structuredClone(byId.get(last)));
    }
    if (segments.at(-2) === "threads") {
      return Response.json({
        id: last,
        historyId: "9100000",
        messages: structuredClone(messages.slice(0, 6)).map((message) => ({
          ...message,
          threadId: last,
        })),
      });
    }
    return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
  }) as typeof fetch;
}
