import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: ocr-image.swift <image-path>\n".utf8))
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: imageURL),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("could not read image: \(imageURL.path)\n".utf8))
    exit(3)
}

func makeRequest(region: CGRect? = nil) -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["ko-KR", "en-US"]
    if let region {
        request.regionOfInterest = region
    }
    return request
}

// 숙소 상세의 흰색 ID는 큰 헤더 이미지 위에 작게 표시되어 전체 OCR에서
// 누락될 수 있다. 전체 화면과 헤더 영역을 각각 읽어 결과를 합친다.
let requests = [
    makeRequest(),
    makeRequest(region: CGRect(x: 0, y: 0.48, width: 1, height: 0.22))
]
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform(requests)
    var seen = Set<String>()
    let lines = requests.flatMap { request in
        (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first?.string
        }
    }.filter { line in
        seen.insert(line).inserted
    }
    print(lines.joined(separator: "\n"))
} catch {
    FileHandle.standardError.write(Data("OCR failed: \(error.localizedDescription)\n".utf8))
    exit(4)
}
