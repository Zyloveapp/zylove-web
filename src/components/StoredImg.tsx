import type { ImgHTMLAttributes } from 'react'
import { usePhotoUrl } from '../hooks/usePhotoUrl'

// 1×1 transparent GIF: keeps the image's box while the URL loads.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// <img> for a stored profile photo (a Storage path, resolved to a short-lived
// URL — services/photoUrls.ts) or any ordinary URL, shown as is. A photo the
// viewer may not see renders blank.
export default function StoredImg({ src, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string | null | undefined }) {
  const { url, retry } = usePhotoUrl(src)
  return <img {...props} src={url || BLANK} onError={retry} />
}
