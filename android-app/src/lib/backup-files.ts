import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

const prefix = 'ggent-backup-'

export async function shareBackupFile(json: string, now = new Date()): Promise<void> {
  try {
    const old = await Filesystem.readdir({ path: '', directory: Directory.Cache })
    await Promise.all(old.files.filter((file) => file.name.startsWith(prefix) && file.name.endsWith('.json')).map((file) =>
      Filesystem.deleteFile({ path: file.name, directory: Directory.Cache }).catch(() => undefined),
    ))
  } catch { /* Cache cleanup is best effort. */ }
  const path = `${prefix}${now.toISOString().replace(/[:.]/g, '-')}.json`
  let uri: string
  try {
    const result = await Filesystem.writeFile({ path, data: json, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
    uri = result.uri
  } catch {
    throw new Error('Nie udało się przygotować pliku kopii.')
  }
  try {
    await Share.share({ title: 'Kopia zapasowa Pantry', dialogTitle: 'Udostępnij kopię Pantry', files: [uri] })
  } catch {
    throw new Error('Nie udało się otworzyć udostępniania kopii.')
  }
}

export async function readBackupFile(file: File): Promise<string> {
  try { return await file.text() }
  catch { throw new Error('Nie udało się odczytać wybranego pliku.') }
}
