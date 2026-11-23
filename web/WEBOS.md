# OpenCADStudio in WebOS

The CAD launcher opens the browser editor with its Rust drawing engine and the local drawing worker. Use **Open** or Ctrl+O to choose a DXF or DWG from My files. Save updates that drawing at its opened revision. Save As asks for a folder and creates a new drawing. If a drawing changed in Files while you were editing, use Save As to keep both versions.

The launcher uses the ordinary editor toolbar and command line. Each drawing tab keeps its own Files revision. In the browser, the Files workflow accepts drawings up to 64 MiB. Desktop-only workflows are described in the [main readme](../README.md#desktop-or-web).

## Build

Install Rust with the `wasm32-unknown-unknown` target, Trunk, Python 3, and the `wasm-bindgen-cli` version pinned by `Cargo.lock`. From the source root run:

```sh
trunk build --config WebOS.Trunk.toml --release --locked
```

Serve `dist/webos` alongside the WebOS mount and its stylesheet. The iframe and the parent Desktop share an origin. The CAD parser and serializer run in the bundled worker. The parent handles Files access and sends a save acknowledgement once the revision is confirmed. The embedded profile leaves the standalone build settings in `Trunk.toml` available.
