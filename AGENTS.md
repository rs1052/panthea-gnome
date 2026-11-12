# AGENTS.md

## Project

Panthea is a native GNOME Shell extension for Wayland. It brings selected Pantheon-inspired features into GNOME while preserving GNOME's native behavior and appearance.

## Development guidelines

- **GNOME first:** Follow GNOME's Human Interface Guidelines, styling, accessibility conventions, and extension best practices.
- **Reuse native functionality:** Prefer existing GNOME APIs, widgets, settings, and behaviors over custom implementations. Keep GNOME as the source of truth wherever possible.
- **Minimize breakage:** Avoid monkey-patching, replacing GNOME internals, and fragile overrides. Isolate unavoidable private API usage.
- **Performance:** Keep the extension lightweight and responsive. Use event-driven updates instead of polling, avoid blocking GNOME Shell, and prevent unnecessary redraws, flickering, and startup delays.
- **Simplicity:** Prefer straightforward solutions with minimal code, dependencies, and abstractions. Avoid unnecessary settings and features.
- **Native appearance:** Inherit GNOME's theme, colors, fonts, scaling, and accessibility settings whenever possible.
- **Clean lifecycle:** Restore original GNOME behavior when disabled. Disconnect signals, remove resources, and avoid permanent system changes.
- **Compatibility:** Use `shell-version` in `metadata.json` as the source of truth for supported GNOME versions. Don't add speculative compatibility code for future releases.
- **Testing:** Test affected functionality and fix actual problems. Avoid extensive test infrastructure, repeated validation, or performance benchmarks unless necessary.

## References

- [GNOME Extension Guide](https://gjs.guide/extensions/)
- [GNOME Human Interface Guidelines](https://developer.gnome.org/hig/)
