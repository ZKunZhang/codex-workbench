export const MAX_TITLE_LENGTH = 200;

export function validateTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入对话标题');
  const title = value.trim();
  if (title.length > MAX_TITLE_LENGTH) throw new Error(`标题不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new Error('标题不能包含换行或控制字符');
  return title;
}
