// share.js — 고객 보내기 링크: {프로젝트 + 사업자명}을 deflate→base64url로 URL 해시(#r=)에
// 담는다. 서버 불요(정적 호스팅 그대로), 해시라 서버 로그에도 안 남는다.
// 받는 쪽: parseShareHash() → 읽기전용 '고객 화면'(내 집 모드 + customer)으로 로드.

const CH = 0x8000;
function b64u(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
async function deflate(str) {
  const cs = new CompressionStream('deflate-raw');
  return new Response(new Blob([new TextEncoder().encode(str)]).stream().pipeThrough(cs)).arrayBuffer();
}
async function inflate(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new TextDecoder().decode(buf);
}

/// 링크 생성 — 너무 크면(메신저 한계) null
export async function makeShareLink(project, biz, baseUrl) {
  const payload = JSON.stringify({
    v: 1,
    biz: { name: biz?.name || '', phone: biz?.phone || '' },
    p: project,
  });
  const b = b64u(await deflate(payload));
  if (b.length > 100000) return null;
  const base = baseUrl ?? (location.origin + location.pathname);
  return base + '#r=' + b;
}

/// 현재 URL이 고객 링크면 {v, biz, p} 반환, 아니면 null
export async function parseShareHash(hash) {
  const h = hash ?? location.hash;
  if (!h.startsWith('#r=')) return null;
  try {
    const d = JSON.parse(await inflate(unb64u(h.slice(3))));
    return d && d.p ? d : null;
  } catch { return null; }
}
