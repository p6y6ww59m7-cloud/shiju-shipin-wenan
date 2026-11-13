import Foundation
import AVFoundation
import AudioToolbox

func stderr(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
}
func little<T: FixedWidthInteger>(_ value: T) -> Data {
    var n = value.littleEndian
    return withUnsafeBytes(of: &n) { Data($0) }
}
func wavHeader(_ bytes: UInt32) -> Data {
    var d = Data("RIFF".utf8); d.append(little(bytes + 36)); d.append(Data("WAVEfmt ".utf8))
    d.append(little(UInt32(16))); d.append(little(UInt16(1))); d.append(little(UInt16(1)))
    d.append(little(UInt32(16000))); d.append(little(UInt32(32000)))
    d.append(little(UInt16(2))); d.append(little(UInt16(16)))
    d.append(Data("data".utf8)); d.append(little(bytes)); return d
}

@main struct AudioPrepare {
    static func main() async {
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--simplify" {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let text = String(decoding: data, as: UTF8.self)
            let simplified = text.applyingTransform(StringTransform("Traditional-Simplified"), reverse: false) ?? text
            FileHandle.standardOutput.write(Data(simplified.utf8)); return
        }
        guard CommandLine.arguments.count == 3 else { stderr(["error": "缺少视频文件。"]); exit(2) }
        let destination = URL(fileURLWithPath: CommandLine.arguments[2])
        do {
            let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
            let tracks = try await asset.loadTracks(withMediaType: .audio)
            guard let track = tracks.first else { throw NSError(domain: "audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "视频没有音轨，无法转写口播。"] ) }
            let duration = try await asset.load(.duration).seconds
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false
            ])
            guard reader.canAdd(output) else { throw NSError(domain: "audio", code: 2, userInfo: [NSLocalizedDescriptionKey: "不能读取这条视频的音轨。"] ) }
            reader.add(output)
            guard reader.startReading() else { throw reader.error ?? NSError(domain: "audio", code: 3) }
            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw NSError(domain: "audio", code: 4) }
            let file = try FileHandle(forWritingTo: destination)
            defer { try? file.close() }
            try file.write(contentsOf: wavHeader(0))
            var total: UInt64 = 0, last = -1
            while let sample = output.copyNextSampleBuffer() {
                guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
                let length = CMBlockBufferGetDataLength(block)
                var data = Data(count: length)
                let status = data.withUnsafeMutableBytes { bytes in
                    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: bytes.baseAddress!)
                }
                guard status == kCMBlockBufferNoErr else { throw NSError(domain: "audio", code: Int(status)) }
                try file.write(contentsOf: data); total += UInt64(length)
                guard total < UInt64(UInt32.max) - 36 else { throw NSError(domain: "audio", code: 5, userInfo: [NSLocalizedDescriptionKey: "音频过长，请分段处理。"] ) }
                let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                let progress = duration > 0 && t.isFinite ? min(99, max(0, Int(t / duration * 100))) : 0
                if progress >= last + 5 { stderr(["progress": progress]); last = progress }
            }
            guard reader.status == .completed else { throw reader.error ?? NSError(domain: "audio", code: 6) }
            guard total > 0 else { throw NSError(domain: "audio", code: 7, userInfo: [NSLocalizedDescriptionKey: "音轨为空，无法转写口播。"] ) }
            try file.seek(toOffset: 0); try file.write(contentsOf: wavHeader(UInt32(total)))
            let result: [String: Any] = ["sampleRate": 16000, "channels": 1, "bytes": total, "duration": Double(total) / 32000]
            print(String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self))
        } catch {
            try? FileManager.default.removeItem(at: destination)
            stderr(["error": error.localizedDescription]); exit(1)
        }
    }
}
