// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FamilyHubMenu",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "FamilyHubMenu", path: "Sources/FamilyHubMenu"),
    ]
)
