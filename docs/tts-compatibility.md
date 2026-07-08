# Zotero TTS compatibility

## Current implementation

- `GET /tts/voices` returns standard and premium local voice metadata.
- `GET /tts/credits` returns deterministic high local credit balances.
- `POST /tts/speak` validates API key access, test key, voice, and text.
- Successful `POST /tts/speak` returns a stable `302` redirect URL for the same voice/text pair.
- `GET /tts/audio/:audioID` returns deterministic local WAV audio bytes.

## Configuration

- Set `TTS_TEST_KEY` to run the official TTS test slice with a dedicated test key.
- If `TTS_TEST_KEY` is absent, the route falls back to `ZOTERO_API_KEY`, then `local-tts-test-key`.

## Known gaps

- The official TTS remote-test slice has not been run against this Worker.
- This is a local compatibility stub, not a production TTS synthesis provider.
- Audio content is deterministic placeholder WAV data, not synthesized speech.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/tts.test.js`
