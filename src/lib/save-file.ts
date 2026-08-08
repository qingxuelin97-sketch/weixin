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
