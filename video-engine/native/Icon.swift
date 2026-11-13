import Cocoa
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 0.11, green: 0.19, blue: 0.15, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 35, y: 35, width: 954, height: 954), xRadius: 220, yRadius: 220).fill()
NSColor(calibratedRed: 0.78, green: 0.95, blue: 0.82, alpha: 1).setStroke()
let arrow = NSBezierPath(); arrow.lineWidth = 65; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 512,y: 780)); arrow.line(to: NSPoint(x: 512,y: 415))
arrow.move(to: NSPoint(x: 350,y: 565)); arrow.line(to: NSPoint(x: 512,y: 405)); arrow.line(to: NSPoint(x: 674,y: 565)); arrow.stroke()
let tray = NSBezierPath(); tray.lineWidth = 57; tray.lineCapStyle = .round; tray.lineJoinStyle = .round
tray.move(to: NSPoint(x: 290,y: 360)); tray.line(to: NSPoint(x: 290,y: 260)); tray.line(to: NSPoint(x: 734,y: 260)); tray.line(to: NSPoint(x: 734,y: 360)); tray.stroke()
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
