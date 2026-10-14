import { beforeEach, describe, expect, it, vi } from 'vitest'

const { calls, writeFile, readdir, deleteFile, share } = vi.hoisted(() => ({
  calls: [] as string[],
  writeFile: vi.fn(async ({ path }: { path: string }) => { calls.push('write'); return { uri: `file:///cache/${path}` } }),
  readdir: vi.fn(async () => ({ files: [] })),
  deleteFile: vi.fn(async () => undefined),
  share: vi.fn(async (options: { files: string[] }) => { calls.push(`share:${options.files[0]}`) }),
}))
vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' }, Filesystem: { writeFile, readdir, deleteFile } }))
vi.mock('@capacitor/share', () => ({ Share: { share } }))
import { shareBackupFile } from '../src/lib/backup-files'

describe('backup file sharing', () => {
  beforeEach(() => { calls.length = 0; writeFile.mockClear(); readdir.mockClear(); share.mockClear() })
  it('writes UTF-8 JSON into cache before sharing its file URI', async () => {
    await shareBackupFile('{"version":1}', new Date('2026-10-14T10:00:00.000Z'))
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ data: '{"version":1}', directory: 'CACHE', encoding: 'utf8', path: 'ggent-backup-2026-10-14T10-00-00-000Z.json' }))
    expect(calls).toEqual(['write', 'share:file:///cache/ggent-backup-2026-10-14T10-00-00-000Z.json'])
  })

  it('does not launch sharing when the cache write fails', async () => {
    writeFile.mockRejectedValueOnce(new Error('disk'))
    await expect(shareBackupFile('{}')).rejects.toThrow('Nie udało się przygotować pliku kopii')
    expect(share).not.toHaveBeenCalled()
  })

  it('turns a share cancellation or failure into a Polish error', async () => {
    share.mockRejectedValueOnce(new Error('cancelled'))
    await expect(shareBackupFile('{}')).rejects.toThrow('Nie udało się otworzyć udostępniania kopii')
  })
})
