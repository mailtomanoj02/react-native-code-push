import Foundation
import SWCompression

/// Obj-C callable helper that uses SWCompression to unzip files.
/// Modeled on hot-updater's ZipDecompressionStrategy.
@objcMembers
public class CodePushZipHelper: NSObject {

    /// Unzips a ZIP file at `path` into the `destination` directory.
    /// Throws on read failure, corrupt archive, or path traversal attempts.
    public static func unzipFile(atPath path: String, toDestination destination: String) throws {
        guard let zipData = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            throw NSError(
                domain: "CodePushZipHelper",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to read ZIP file at: \(path)"]
            )
        }

        let zipEntries: [ZipEntry]
        do {
            zipEntries = try ZipContainer.open(container: zipData)
        } catch {
            throw NSError(
                domain: "CodePushZipHelper",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "ZIP extraction failed: \(error.localizedDescription)"]
            )
        }

        let destinationURL = URL(fileURLWithPath: destination)
        let canonicalDestination = destinationURL.standardized.path

        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: canonicalDestination) {
            try fileManager.createDirectory(
                atPath: canonicalDestination,
                withIntermediateDirectories: true,
                attributes: nil
            )
        }

        for entry in zipEntries {
            try extractEntry(entry, to: canonicalDestination)
        }
    }

    // MARK: - Private

    private static func extractEntry(_ entry: ZipEntry, to destination: String) throws {
        let fileManager = FileManager.default
        let entryPath = entry.info.name.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard !entryPath.isEmpty,
              !entryPath.contains(".."),
              !entryPath.hasPrefix("/") else {
            NSLog("[CodePushZip] Skipping suspicious path: %@", entry.info.name)
            return
        }

        let fullPath = (destination as NSString).appendingPathComponent(entryPath)
        let canonicalFullPath = URL(fileURLWithPath: fullPath).standardized.path
        let canonicalDestination = URL(fileURLWithPath: destination).standardized.path

        guard canonicalFullPath.hasPrefix(canonicalDestination + "/") ||
              canonicalFullPath == canonicalDestination else {
            throw NSError(
                domain: "CodePushZipHelper",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Path traversal attempt detected: \(entry.info.name)"]
            )
        }

        if entry.info.type == .directory {
            if !fileManager.fileExists(atPath: canonicalFullPath) {
                try fileManager.createDirectory(
                    atPath: canonicalFullPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }
            return
        }

        if entry.info.type == .regular {
            let parentPath = (canonicalFullPath as NSString).deletingLastPathComponent
            if !fileManager.fileExists(atPath: parentPath) {
                try fileManager.createDirectory(
                    atPath: parentPath,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            }

            guard let data = entry.data else {
                NSLog("[CodePushZip] Skipping file with no data: %@", entry.info.name)
                return
            }

            try data.write(to: URL(fileURLWithPath: canonicalFullPath))
        }
    }
}
