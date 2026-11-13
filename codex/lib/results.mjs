import { AdapterError } from './http.mjs'

export const textResult = (body, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
})
export function imageResult(png, metadata = {}) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(signature) ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new AdapterError('invalid_image', 'The returned file is not a PNG image.')
  }
  if (png.length > 16 * 1024 * 1024)
    throw new AdapterError('image_too_large', 'PNG exceeds 16 MiB; render a smaller preview.')
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          ...metadata,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        }),
      },
      { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    ],
  }
}
