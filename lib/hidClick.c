// Real HID events. System Events' `click at` is synthetic and FocuSee's custom drop-zone view
// ignores it; CGEvent posts what a mouse actually posts.
#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>

static void post(CGEventType t, CGPoint p, CGMouseButton b) {
    CGEventRef e = CGEventCreateMouseEvent(NULL, t, p, b);
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: click x y [x2 y2]\n"); return 2; }
    CGPoint a = CGPointMake(atof(argv[1]), atof(argv[2]));
    post(kCGEventMouseMoved, a, kCGMouseButtonLeft);
    usleep(200000);
    post(kCGEventLeftMouseDown, a, kCGMouseButtonLeft);
    if (argc >= 5) {                     // drag
        CGPoint b = CGPointMake(atof(argv[3]), atof(argv[4]));
        for (int i = 1; i <= 25; i++) {
            CGPoint m = CGPointMake(a.x + (b.x - a.x) * i / 25.0, a.y + (b.y - a.y) * i / 25.0);
            post(kCGEventLeftMouseDragged, m, kCGMouseButtonLeft);
            usleep(20000);
        }
        usleep(300000);
        post(kCGEventLeftMouseUp, b, kCGMouseButtonLeft);
    } else {
        usleep(80000);
        post(kCGEventLeftMouseUp, a, kCGMouseButtonLeft);
    }
    return 0;
}
