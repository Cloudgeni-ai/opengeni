import gi
import json
import os
import sys

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

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


def save():
    state = {"pid": os.getpid(), "value": entry.get_text(), "clicks": count}
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
entry.connect("changed", lambda _: save())
for child in [entry, button, label]:
    box.pack_start(child, False, False, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()
GLib.timeout_add(100, save)
Gtk.main()
