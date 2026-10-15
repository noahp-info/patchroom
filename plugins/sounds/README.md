# Patchroom sound packs

- Generated packs (Patch Tones, Telegraph, Night Shift, Modular) are note tables in generated-packs.json, synthesized in the app (Apache-2.0).
- File packs are folders with pack.json, sounds/<event>.m4a and a LICENSE. All shipped file packs are CC0 by Kenney (kenney.nl).
- A manifest may carry `norm: {<event>: gain}`, a multiplier (0.05 to 8) the app applies on top of the file, never written into it. Leave it out for a gain of 1. Switchboard uses it to pull two clicks whose decoded peak sits slightly above -2.5 dBFS back under the cap.
- Events: needs, done, message, error, bell, decision, due, session.
- Third-party audio is only ever added with a license that allows redistribution in this Apache-2.0 repository.
