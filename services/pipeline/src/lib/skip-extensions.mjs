/**
 * Extensions never extracted or indexed as text — media/binary/archive/executable/db
 * formats. Matched case-insensitively against the file's extension (no leading dot).
 */
export const SKIP_EXTENSIONS = new Set([
  // images
  'jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'webp', 'svg', 'ico',
  'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'psd', 'ai', 'eps', 'indd',
  // video
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts',
  // audio
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'aiff', 'aif', 'opus', 'caf',
  // archives / disk images
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso', 'pkg', 'img', 'vhd', 'vmdk',
  // executables / compiled binaries
  'exe', 'dll', 'so', 'dylib', 'app', 'msi', 'bin', 'deb', 'rpm', 'class', 'jar', 'war',
  // databases
  'sqlite', 'sqlite3', 'db', 'mdb', 'accdb',
  // Apple-specific bundles / sidecars
  'photoslibrary', 'aae', 'icloud', 'localized',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // design tools (proprietary binary containers, not text-extractable)
  'sketch', 'fig', 'xd',
  // Apple iWork (zip containers docling does not parse)
  'pages', 'key', 'numbers',
]);

export function shouldSkipExtension(ext) {
  if (typeof ext !== 'string') return false;
  return SKIP_EXTENSIONS.has(ext.toLowerCase().replace(/^\./u, ''));
}
