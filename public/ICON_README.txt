The manifest uses square PNGs: icon16.png, icon48.png, icon128.png (generated from icon.png).
Chrome rejects non-square or wrong-size icons for manifest keys. After changing icon.png, run:
  cd public && sips -z 128 128 icon.png --out icon128.png && sips -z 48 48 icon128.png --out icon48.png && sips -z 16 16 icon128.png --out icon16.png
