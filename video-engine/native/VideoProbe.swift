import Foundation
import AVFoundation

@main struct VideoProbe {
    static func main() async {
        guard CommandLine.arguments.count == 2 else { exit(2) }
        do {
            let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
            let duration = try await asset.load(.duration).seconds
            let tracks = try await asset.loadTracks(withMediaType: .video)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            guard let track = tracks.first, duration.isFinite, duration > 0 else { throw NSError(domain: "video", code: 1) }
            let size = try await track.load(.naturalSize)
            let transform = try await track.load(.preferredTransform)
            let transformed = size.applying(transform)
            let data: [String: Any] = ["duration": duration, "videoTracks": tracks.count, "audioTracks": audio.count,
                "width": Int(abs(transformed.width)), "height": Int(abs(transformed.height))]
            let json = try JSONSerialization.data(withJSONObject: data)
            print(String(decoding: json, as: UTF8.self))
        } catch {
            FileHandle.standardError.write(Data("视频文件不可播放或不完整。\n".utf8))
            exit(1)
        }
    }
}
