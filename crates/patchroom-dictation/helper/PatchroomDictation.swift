// patchroom-dictation: on-device dictation for Patchroom's chat composer.
//
// Speech never leaves the Mac. Recognition runs only with requiresOnDeviceRecognition = true;
// when a language has no on-device model, the helper says so and stops. It never falls back to
// Apple's servers.
//
// Protocol (crates/patchroom-dictation/src/protocol.rs): one JSON object per line on stdout.
//   --dictate [--locale <id>]   ask for permission if never asked, listen, stream partials
//   --list-locales              languages with their on-device state, and permission states
// stdin: "stop" ends the audio and sends the final text. End of input means the app is gone:
// exit at once.
//
// Data handling: audio stays in memory buffers handed to the recognizer. Nothing is written to
// disk and nothing is logged. stderr is unused. The helper starts no child processes.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
    var line = String(data: data, encoding: .utf8)
  else { return }
  line += "\n"
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func languageName(_ id: String) -> String {
  Locale.current.localizedString(forIdentifier: id) ?? id
}

func speechState() -> String {
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not_determined"
  @unknown default: return "unknown"
  }
}

func micState() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not_determined"
  @unknown default: return "unknown"
  }
}

func listLocales() -> Never {
  var out: [[String: Any]] = []
  for loc in SFSpeechRecognizer.supportedLocales() {
    let id = loc.identifier.replacingOccurrences(of: "_", with: "-")
    let onDevice = SFSpeechRecognizer(locale: loc)?.supportsOnDeviceRecognition ?? false
    out.append(["id": id, "name": languageName(id), "onDevice": onDevice])
  }
  out.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
  let current = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
  emit([
    "type": "locales", "locales": out, "current": current, "speech": speechState(),
    "mic": micState(),
  ])
  exit(0)
}

final class Dictation {
  let localeId: String
  let engine = AVAudioEngine()
  let request = SFSpeechAudioBufferRecognitionRequest()
  var recognizer: SFSpeechRecognizer?
  var task: SFSpeechRecognitionTask?
  var lastText = ""
  var finished = false
  var stopping = false

  init(localeId: String) {
    self.localeId = localeId
  }

  func fail(_ code: String, _ message: String) {
    emit([
      "type": "error", "code": code, "message": message, "locale": localeId,
      "language": languageName(localeId),
    ])
    finish()
  }

  /// Say `end` once and leave.
  func finish() {
    if finished { return }
    finished = true
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    task?.cancel()
    emit(["type": "end"])
    exit(0)
  }

  // Permission is asked here, on the first dictation, never at app launch.
  func start() {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: askMic()
    case .denied: fail("speech_denied", "Speech recognition is turned off for Patchroom.")
    case .restricted: fail("speech_restricted", "Speech recognition is restricted on this Mac.")
    case .notDetermined:
      SFSpeechRecognizer.requestAuthorization { _ in
        DispatchQueue.main.async { self.start() }
      }
    @unknown default: fail("speech_denied", "Speech recognition is not allowed.")
    }
  }

  func askMic() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: listen()
    case .denied: fail("mic_denied", "Microphone access is turned off for Patchroom.")
    case .restricted: fail("mic_restricted", "Microphone access is restricted on this Mac.")
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { _ in
        DispatchQueue.main.async { self.askMic() }
      }
    @unknown default: fail("mic_denied", "Microphone access is not allowed.")
    }
  }

  func listen() {
    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)),
      rec.supportsOnDeviceRecognition
    else {
      // No server fallback, ever.
      fail("on_device_unavailable", "On-device dictation isn't available for this language.")
      return
    }
    recognizer = rec
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.addsPunctuation = true

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    if format.sampleRate == 0 || format.channelCount == 0 {
      fail("audio", "No microphone is connected.")
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buf, _ in
      request.append(buf)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      fail("audio", "The microphone could not start.")
      return
    }

    task = rec.recognitionTask(with: request) { result, error in
      DispatchQueue.main.async { self.handle(result, error) }
    }
    emit(["type": "ready", "locale": localeId])
  }

  func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    if finished { return }
    if let r = result {
      let text = r.bestTranscription.formattedString
      if r.isFinal {
        emit(["type": "final", "text": text])
        lastText = ""
        if stopping { finish() }
        return
      }
      if text != lastText {
        lastText = text
        emit(["type": "partial", "text": text])
      }
    }
    if error != nil {
      if stopping {
        // Ending the audio can close the task with an error; keep what was heard.
        if !lastText.isEmpty { emit(["type": "final", "text": lastText]) }
        finish()
      } else {
        fail("recognizer", "Dictation stopped unexpectedly.")
      }
    }
  }

  /// The person stopped: close the microphone, then wait briefly for the final text.
  func stop() {
    if stopping || finished { return }
    stopping = true
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    request.endAudio()
    if task == nil { finish() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
      if !self.lastText.isEmpty && !self.finished { emit(["type": "final", "text": self.lastText]) }
      self.finish()
    }
  }
}

let args = CommandLine.arguments
if args.contains("--list-locales") { listLocales() }
guard args.contains("--dictate") else {
  FileHandle.standardError.write("usage: patchroom-dictation --dictate [--locale id] | --list-locales\n".data(using: .utf8)!)
  exit(2)
}
var localeId = Locale.current.identifier
if let i = args.firstIndex(of: "--locale"), i + 1 < args.count, !args[i + 1].isEmpty {
  localeId = args[i + 1]
}
localeId = localeId.replacingOccurrences(of: "_", with: "-")

let dictation = Dictation(localeId: localeId)

// stdin: "stop" finishes; end of input (the app quit or crashed) exits at once.
Thread.detachNewThread {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespaces) == "stop" {
      DispatchQueue.main.async { dictation.stop() }
    }
  }
  exit(0)
}

DispatchQueue.main.async { dictation.start() }
dispatchMain()
