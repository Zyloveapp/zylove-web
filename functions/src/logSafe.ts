// F-088: log hygiene. Logs never carry a Spark matchId (it's the two uids),
// a Play ID next to the uid it belongs to, phone numbers, emails or message
// text. Where a log line needs to tie events together, it uses logId(): a
// short sha256 prefix, stable for the same input, that can't be turned back
// into the uids.
import { createHash } from 'node:crypto'

export function logId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

// A Storage photo path for a log line that also names the uid. Spark paths
// (photos/{uid}/…) only repeat the uid; a Play path (playPhotos/{playId}/…)
// would link the Play ID to the account, so it becomes the mode plus a hash.
export function photoPathForLog(path: string): string {
  return path.startsWith('playPhotos/') ? `play:${logId(path)}` : path
}

// An error message for a log line that names the uid: Storage errors quote the
// object path, so the Play ID in any playPhotos/ path is dropped.
export function redactPlayPaths(message: string): string {
  return message.replace(/playPhotos\/[^\s/'"]+/g, 'playPhotos/…')
}
