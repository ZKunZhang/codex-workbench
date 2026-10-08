let token = '';
export function setToken(next: string) { token = next; }
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const result = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const json = await result.json();
  if (!result.ok) throw new Error(json.error || '请求失败，请重试');
  return json;
}
