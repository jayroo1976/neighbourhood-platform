Marina Residence - web app icon set
====================================
any/       plain square icons for page UI
maskable/  icons with background safe-zone padding for the manifold
           "purpose":"maskable" entries and install prompts
Sizes: 512,256,192,144,96,48,32 px (square PNG, RGB).
Slugs: app, plumbing, electrical, elevator, hvac, lighting, cleaning,
       security, parking, pool
manifest.webmanifest references the MAIN APP ICON for both any and maskable.
Drop this folder at your web root so the relative paths resolve, then link:
  <link rel="manifest" href="/manifest.webmanifest">
background_color / theme_color in the manifest are placeholders.
