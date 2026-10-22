import gi
import json
import os
import sys

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk

state_path, title = sys.argv[1:]
window = Gtk.Window(title=title)
window.set_default_size(460, 280)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=16)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Fixture text")
button = Gtk.Button(label="Increment")
label = Gtk.Label(label="Count: 0")
count = 0
pointer_events = []


def save():
    state = {"pid": os.getpid(), "value": entry.get_text(), "clicks": count,
             "pointer_events": pointer_events,
             "composited": Gdk.Screen.get_default().is_composited()}
    with open(state_path + ".tmp", "w") as output:
        json.dump(state, output)
    os.replace(state_path + ".tmp", state_path)
    return True


def increment(_):
    global count
    count += 1
    label.set_text("Count: " + str(count))
    save()


button.connect("clicked", increment)


def pointer_event(_, event):
    pointer_events.append({"type": str(event.type), "x": event.x, "y": event.y,
                           "screen_x": event.x_root, "screen_y": event.y_root})
    save()
    return False


button.connect("button-press-event", pointer_event)
button.connect("button-release-event", pointer_event)
entry.connect("changed", lambda _: save())
for child in [entry, button, label]:
    box.pack_start(child, False, False, 0)
window.connect("destroy", Gtk.main_quit)
# A decorated window at the screen origin must not have its border counted
# twice when translating accessibility bounds to screenshot coordinates.
window.move(0, 0)
window.show_all()
GLib.timeout_add(100, save)
Gtk.main()
