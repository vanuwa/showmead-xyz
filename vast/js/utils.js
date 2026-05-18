export function selectMediaFile(files) {
  if (!files || !files.length) return null;
  const mp4prog = files.filter(f => f.delivery === 'progressive' && f.type.includes('mp4'));
  if (mp4prog.length) return mp4prog[0];
  const prog = files.filter(f => f.delivery === 'progressive');
  if (prog.length) return prog[0];
  const mp4 = files.filter(f => f.type.includes('mp4'));
  if (mp4.length) return mp4[0];
  return files[0];
}

export function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max) + '…' : s;
}
