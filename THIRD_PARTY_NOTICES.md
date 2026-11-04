# Third-party notices

This file identifies third-party components and assets used by this repository. Dependency versions are taken from `package-lock.json`.

## Browser application dependencies

| Component | Locked version | License | Notes |
| --- | --- | --- | --- |
| [`@revenuecat/purchases-js`](https://www.npmjs.com/package/@revenuecat/purchases-js/v/1.73.2) | 1.73.2 | MIT | RevenueCat web purchases SDK. |
| [`lucide-react`](https://www.npmjs.com/package/lucide-react/v/0.468.0) | 0.468.0 | ISC | Includes Lucide icons and portions of Feather icons; see the included ISC notice in the public notices file. |
| [`react`](https://www.npmjs.com/package/react/v/19.3.1) | 19.3.1 | MIT | React runtime. |
| [`react-dom`](https://www.npmjs.com/package/react-dom/v/19.3.1) | 19.3.1 | MIT | Browser renderer; depends on Scheduler. |
| [`scheduler`](https://www.npmjs.com/package/scheduler/v/0.28.0) | 0.28.0 | MIT | React DOM runtime dependency. |

The full MIT and ISC license notices for these browser dependencies are available in [`public/notices/THIRD_PARTY_NOTICES.txt`](public/notices/THIRD_PARTY_NOTICES.txt), which is also served by the app at `/notices/THIRD_PARTY_NOTICES.txt`.

## Build tooling

[`vite`](https://www.npmjs.com/package/vite/v/6.4.5) 6.4.5 is the locked development/build tool and is licensed under MIT. It is not a runtime dependency of the browser app. Its license text is available from the [Vite v6.4.5 source](https://github.com/vitejs/vite/blob/v6.4.5/LICENSE). Other locked build-tool transitive dependencies and their declared license identifiers are recorded in `package-lock.json`.

## Fonts

The bundled IBM Plex Sans and IBM Plex Mono WOFF2 files in `public/fonts/` are distributed under the SIL Open Font License, Version 1.1. The copyright and complete OFL text are retained in [`public/fonts/OFL.txt`](public/fonts/OFL.txt). Do not remove that license file when redistributing the fonts.

## Artwork and brand asset provenance

The three illustrations in `public/illustrations/` (`device-toy.webp`, `device-watch.webp`, and `device-band.webp`) are owner-provided Midjourney-generated artwork. This repository does not place them under an open-source license or make a separate representation about reuse rights; confirm rights and applicable service terms with the asset owner before reuse.

`public/brand/hardviser-datum-h.svg` is an owner-provided brand asset. No separate open-source license or reuse grant is stated for it.

The notices above apply only to the named third-party components and fonts. They do not grant a license to the Hardviser application, brand assets, or owner-provided artwork. No root project license is included.
