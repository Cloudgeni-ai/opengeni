import gi
import json
import os
import sys

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib

state_path, title, decorations = sys.argv[1:]
count = 0


def save():
    with open(state_path + ".tmp", "w") as output:
        json.dump({"pid": os.getpid(), "clicks": count}, output)
    os.replace(state_path + ".tmp", state_path)
    return True


def activate(app):
    window = Gtk.ApplicationWindow(application=app, title=title)
    window.set_default_size(460, 280)
    if decorations == "client":
        window.set_titlebar(Gtk.HeaderBar())
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    for side in ["top", "bottom", "start", "end"]:
        getattr(box, "set_margin_" + side)(16)
    button = Gtk.Button(label="Increment")
    label = Gtk.Label(label="Count: 0")

    def increment(_):
        global count
        count += 1
        label.set_label("Count: " + str(count))
        save()

    button.connect("clicked", increment)
    box.append(button)
    box.append(label)
    window.set_child(box)
    window.present()
    GLib.timeout_add(100, save)


app = Gtk.Application(application_id="test.example.CuaCoordinateFixture")
app.connect("activate", activate)
app.run([])
