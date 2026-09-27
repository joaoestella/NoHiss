# Third-party notices

NoHiss uses the following third-party components in its Voice (AI) filter.
The corresponding license texts are distributed with the extension. These
notices apply to the third-party components and do not assign a license to
NoHiss's own code. Attribution does not imply endorsement by the upstream
authors or organizations.

## RNNoise

RNNoise is a neural-network-based noise suppression library developed by
Jean-Marc Valin and other contributors. It is included in the WebAssembly
binary embedded in `audio/vendor/rnnoise-sync.js`.

- Project: https://github.com/xiph/rnnoise
- License: BSD-3-Clause.
- Full license and copyright notices: [RNNOISE-LICENSE.txt](audio/vendor/RNNOISE-LICENSE.txt).
- RNNoise submodule revision recorded by the Jitsi distribution:
  `372f7b4b76cde4ca1ec4605353dd17898a99de38`.
- License source at that revision:
  https://github.com/xiph/rnnoise/blob/372f7b4b76cde4ca1ec4605353dd17898a99de38/COPYING

Copyright notices from that revision:

```text
Copyright (c) 2007-2017, 2024 Jean-Marc Valin
Copyright (c) 2023 Amazon
Copyright (c) 2017, Mozilla
Copyright (c) 2005-2017, Xiph.Org Foundation
Copyright (c) 2003-2004, Mark Borgerding
```

## Jitsi rnnoise-wasm

Jitsi's rnnoise-wasm distribution packages RNNoise for use through WebAssembly.
NoHiss uses its synchronous JavaScript loader with an embedded WASM binary.

- Project: https://github.com/jitsi/rnnoise-wasm
- License: Apache-2.0; the upstream license file also preserves a historical
  MIT notice for ESTOS GmbH and BlueJimp SARL.
- Full license and preserved notices:
  [RNNOISE-WASM-LICENSE.txt](audio/vendor/RNNOISE-WASM-LICENSE.txt).
- Distribution revision:
  `9ee77cea4f40d3e88b6972a916193e2c96e7506e`.
- Source of the distributed file:
  https://github.com/jitsi/rnnoise-wasm/blob/9ee77cea4f40d3e88b6972a916193e2c96e7506e/dist/rnnoise-sync.js
- License source:
  https://github.com/jitsi/rnnoise-wasm/blob/9ee77cea4f40d3e88b6972a916193e2c96e7506e/LICENSE

Local changes to this vendored file: line endings were converted to Windows
CRLF. No other changes were found when compared with the pinned upstream
file on 2026-09-27. The embedded WASM binary is unchanged. NoHiss's audio
wrappers and controls are separate files.

## Integrity and redistribution

SHA-256 of the local `audio/vendor/rnnoise-sync.js` file:

```text
d8679704d55effe88b10c39ad133b58ce27d9b861c6402efaaff9634d09234a7
```

SHA-256 of its decoded embedded WASM binary:

```text
4f513a50613de74378331237886138eab52fa2650e8b1a41eb587d932d9b8850
```

Git line-ending conversion can change the JavaScript file hash without
changing its code or embedded WASM. Review these references and hashes when
updating the dependency.

Keep this file and both full license files in source distributions and
extension release packages. Preserve the upstream copyright, license and
attribution notices, and identify modifications to third-party files when
applicable. The full license texts govern use and redistribution.
