/**
 * Save a text file to the user's device. On Android a WebView ignores
 * blob+<a download> entirely (real-device bug H2) — write a real file and hand
 * it to the system share sheet; on the web the classic anchor download works.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export async function saveTextFile(
  name: string,
  text: string,
  mime = 'application/json',
  dialogTitle = '保存文件',
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const written = await Filesystem.writeFile({
      path: name,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    const stat = await Filesystem.stat({ path: name, directory: Directory.Cache });
    if (!stat.size) throw new Error('文件写入校验失败');
    await Share.share({ title: name, url: written.uri, dialogTitle });
    return;
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Binary sibling (M-J12, for the report's long-image PNG): same two paths —
 * on Android write a real file (base64, no Encoding = binary for Capacitor
 * Filesystem) and hand it to the share sheet; on the web the anchor download.
 */
export async function saveBlobFile(
  name: string,
  blob: Blob,
  dialogTitle = '保存文件',
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('读取图片数据失败'));
      // result = data:<mime>;base64,<payload> — Filesystem wants the payload.
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
      r.readAsDataURL(blob);
    });
    if (!base64) throw new Error('图片数据为空');
    const written = await Filesystem.writeFile({
      path: name,
      data: base64,
      directory: Directory.Cache,
    });
    const stat = await Filesystem.stat({ path: name, directory: Directory.Cache });
    if (!stat.size) throw new Error('文件写入校验失败');
    await Share.share({ title: name, url: written.uri, dialogTitle });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
