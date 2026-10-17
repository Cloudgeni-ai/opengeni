//! Layer application against a reference model, and its edge cases.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::MetadataExt as _;

use proptest::prelude::*;

use super::*;

/// What the model holds at a path.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Dir,
    File { content: Vec<u8>, mode: u32 },
    Symlink(String),
}

type Tree = BTreeMap<String, Node>;

/// One entry of a layer.
#[derive(Debug, Clone)]
enum Op {
    File(&'static str, u8, u32),
    Dir(&'static str),
    Symlink(&'static str, &'static str),
    Hardlink(&'static str, &'static str),
    Whiteout(&'static str),
    Opaque(&'static str),
}

// Directories are only ever directories, files and links only ever leaves,
// so the model needs no symlink resolution; the resolution itself has its
// own tests.
const DIRS: &[&str] = &["a", "b", "a/c", "a/d"];
const FILES: &[&str] = &["f", "a/f", "b/f", "a/c/f", "a/d/g"];
const LINKS: &[&str] = &["s", "a/s"];
const HARD: &[&str] = &["h", "a/h"];
const MODES: &[u32] = &[0o644, 0o755, 0o600, 0o4755];

fn any_path() -> impl Strategy<Value = &'static str> {
    prop::sample::select([DIRS, FILES, LINKS, HARD].concat())
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (prop::sample::select(FILES), any::<u8>(), prop::sample::select(MODES))
            .prop_map(|(path, byte, mode)| Op::File(path, byte, mode)),
        2 => prop::sample::select(DIRS).prop_map(Op::Dir),
        1 => (prop::sample::select(LINKS), prop::sample::select(&["f", "/nowhere", "../a"][..]))
            .prop_map(|(path, target)| Op::Symlink(path, target)),
        1 => (prop::sample::select(HARD), prop::sample::select(FILES))
            .prop_map(|(path, source)| Op::Hardlink(path, source)),
        2 => any_path().prop_map(Op::Whiteout),
        1 => prop::sample::select(DIRS).prop_map(Op::Opaque),
    ]
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn remove_tree(tree: &mut Tree, path: &str) {
    let prefix = format!("{path}/");
    tree.retain(|key, _| key != path && !key.starts_with(&prefix));
}

fn ensure_dirs(tree: &mut Tree, path: &str) {
    let mut at = String::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        if !at.is_empty() {
            at.push('/');
        }
        at.push_str(part);
        tree.entry(at.clone()).or_insert(Node::Dir);
    }
}

/// The model: a layer's deletions apply first, to the layers below, then
/// its entries in order. `None` where application must fail.
fn model(layers: &[Vec<Op>]) -> Option<Tree> {
    let mut tree = Tree::new();
    for layer in layers {
        for op in layer {
            match op {
                Op::Whiteout(path) => remove_tree(&mut tree, path),
                Op::Opaque(dir) => {
                    let prefix = format!("{dir}/");
                    tree.retain(|key, _| !key.starts_with(&prefix));
                }
                _ => {}
            }
        }
        for op in layer {
            match *op {
                Op::Whiteout(path) => ensure_dirs(&mut tree, parent(path)),
                Op::Opaque(dir) => ensure_dirs(&mut tree, dir),
                Op::File(path, byte, mode) => {
                    ensure_dirs(&mut tree, parent(path));
                    remove_tree(&mut tree, path);
                    tree.insert(
                        path.into(),
                        Node::File {
                            content: vec![byte; 3],
                            mode,
                        },
                    );
                }
                Op::Dir(path) => {
                    ensure_dirs(&mut tree, parent(path));
                    if tree.get(path) != Some(&Node::Dir) {
                        remove_tree(&mut tree, path);
                        tree.insert(path.into(), Node::Dir);
                    }
                }
                Op::Symlink(path, target) => {
                    ensure_dirs(&mut tree, parent(path));
                    remove_tree(&mut tree, path);
                    tree.insert(path.into(), Node::Symlink(target.into()));
                }
                Op::Hardlink(path, source) => {
                    let node @ Node::File { .. } = tree.get(source)?.clone() else {
                        return None;
                    };
                    ensure_dirs(&mut tree, parent(path));
                    remove_tree(&mut tree, path);
                    tree.insert(path.into(), node);
                }
            }
        }
    }
    Some(tree)
}

fn header(kind: EntryType, mode: u32, size: u64) -> tar::Header {
    let mut header = tar::Header::new_ustar();
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_size(size);
    header.set_mtime(1_700_000_000);
    header.set_uid(0);
    header.set_gid(0);
    header
}

fn tar_of(ops: &[Op]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for op in ops {
        match *op {
            Op::File(path, byte, mode) => {
                let mut h = header(EntryType::Regular, mode, 3);
                builder.append_data(&mut h, path, &[byte; 3][..]).unwrap();
            }
            Op::Dir(path) => {
                let mut h = header(EntryType::Directory, 0o750, 0);
                builder
                    .append_data(&mut h, format!("{path}/"), &[][..])
                    .unwrap();
            }
            Op::Symlink(path, target) => {
                let mut h = header(EntryType::Symlink, 0o777, 0);
                builder.append_link(&mut h, path, target).unwrap();
            }
            Op::Hardlink(path, source) => {
                let mut h = header(EntryType::Link, 0o644, 0);
                builder.append_link(&mut h, path, source).unwrap();
            }
            Op::Whiteout(path) => {
                let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
                let marker = if dir.is_empty() {
                    format!(".wh.{name}")
                } else {
                    format!("{dir}/.wh.{name}")
                };
                let mut h = header(EntryType::Regular, 0o644, 0);
                builder.append_data(&mut h, marker, &[][..]).unwrap();
            }
            Op::Opaque(dir) => {
                let mut h = header(EntryType::Regular, 0o644, 0);
                builder
                    .append_data(&mut h, format!("{dir}/{OPAQUE}"), &[][..])
                    .unwrap();
            }
        }
    }
    builder.into_inner().unwrap()
}

/// What is on disk under `root`, as the model holds it.
fn on_disk(root: &Path) -> Tree {
    fn walk(root: &Path, dir: &Path, tree: &mut Tree) {
        for child in fs::read_dir(dir).unwrap() {
            let path = child.unwrap().path();
            let key = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let meta = fs::symlink_metadata(&path).unwrap();
            let node = if meta.file_type().is_symlink() {
                Node::Symlink(fs::read_link(&path).unwrap().to_string_lossy().into_owned())
            } else if meta.is_dir() {
                walk(root, &path, tree);
                Node::Dir
            } else {
                Node::File {
                    content: fs::read(&path).unwrap(),
                    mode: meta.permissions().mode() & 0o7777,
                }
            };
            tree.insert(key, node);
        }
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree);
    tree
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn layers_apply_as_the_model_says(
        layers in prop::collection::vec(prop::collection::vec(op(), 0..8), 1..5)
    ) {
        let dir = tempfile::tempdir().unwrap();
        let tars: Vec<Vec<u8>> = layers.iter().map(|ops| tar_of(ops)).collect();
        let applied = apply_all(dir.path(), &tars);
        match model(&layers) {
            Some(expected) => {
                prop_assert!(applied.is_ok(), "{applied:?}");
                prop_assert_eq!(on_disk(dir.path()), expected);
            }
            None => prop_assert!(applied.is_err()),
        }
    }
}

#[test]
fn a_whiteout_hides_only_lower_layers() {
    let dir = tempfile::tempdir().unwrap();
    let lower = tar_of(&[Op::File("a/f", 1, 0o644), Op::File("b/f", 2, 0o644)]);
    // The same layer deletes a/f below and adds it again; b/f goes.
    let upper = tar_of(&[
        Op::File("a/f", 3, 0o644),
        Op::Whiteout("a/f"),
        Op::Whiteout("b/f"),
    ]);
    let applied = apply_all(dir.path(), &[lower, upper]).unwrap();
    assert_eq!(fs::read(dir.path().join("a/f")).unwrap(), [3, 3, 3]);
    assert!(!dir.path().join("b/f").exists());
    assert!(dir.path().join("b").is_dir());
    assert_eq!(applied.deleted, 2);
}

#[test]
fn an_opaque_directory_keeps_only_its_own_layer() {
    let dir = tempfile::tempdir().unwrap();
    let lower = tar_of(&[Op::File("a/c/f", 1, 0o644), Op::File("a/f", 1, 0o644)]);
    let upper = tar_of(&[Op::File("a/d/g", 2, 0o644), Op::Opaque("a")]);
    apply_all(dir.path(), &[lower, upper]).unwrap();
    assert_eq!(
        on_disk(dir.path()).keys().collect::<Vec<_>>(),
        ["a", "a/d", "a/d/g"]
    );
}

#[test]
fn entries_never_leave_the_root() {
    let outside = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let target = outside.path().to_string_lossy().into_owned();
    let mut builder = tar::Builder::new(Vec::new());
    let mut h = header(EntryType::Symlink, 0o777, 0);
    builder.append_link(&mut h, "etc", &target).unwrap();
    let mut h = header(EntryType::Symlink, 0o777, 0);
    builder
        .append_link(&mut h, "up", "../../../../../..")
        .unwrap();
    let lower = builder.into_inner().unwrap();
    let mut builder = tar::Builder::new(Vec::new());
    let mut h = header(EntryType::Regular, 0o644, 1);
    builder
        .append_data(&mut h, "etc/passwd", &b"x"[..])
        .unwrap();
    let mut h = header(EntryType::Regular, 0o644, 1);
    builder
        .append_data(&mut h, "up/escaped", &b"y"[..])
        .unwrap();
    let upper = builder.into_inner().unwrap();
    apply_all(dir.path(), &[lower, upper]).unwrap();
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    // Both land where a container would put them: inside the root.
    let resolved = dir
        .path()
        .join(target.trim_start_matches('/'))
        .join("passwd");
    assert_eq!(fs::read(resolved).unwrap(), b"x");
    assert_eq!(fs::read(dir.path().join("escaped")).unwrap(), b"y");
    // A path with `..` in it is refused.
    let mut builder = tar::Builder::new(Vec::new());
    let mut h = header(EntryType::Regular, 0o644, 1);
    h.as_old_mut().name[..6].copy_from_slice(b"../x\0\0");
    h.set_cksum();
    builder.append(&h, &b"z"[..]).unwrap();
    assert!(apply_all(dir.path(), &[builder.into_inner().unwrap()]).is_err());
}

#[test]
fn hard_links_share_their_file() {
    let dir = tempfile::tempdir().unwrap();
    let layer = tar_of(&[Op::File("a/f", 7, 0o755), Op::Hardlink("a/h", "a/f")]);
    apply_all(dir.path(), &[layer]).unwrap();
    let file = fs::metadata(dir.path().join("a/f")).unwrap();
    let link = fs::metadata(dir.path().join("a/h")).unwrap();
    assert_eq!((file.ino(), file.nlink()), (link.ino(), 2));
}

#[test]
fn contents_must_match_the_diff_id() {
    let dir = tempfile::tempdir().unwrap();
    let tar = tar_of(&[Op::File("f", 1, 0o644)]);
    let path = dir.path().join("layer.tar.gz");
    let mut gz =
        flate2::write::GzEncoder::new(File::create(&path).unwrap(), flate2::Compression::fast());
    gz.write_all(&tar).unwrap();
    gz.finish().unwrap();
    let good = Layer {
        path: path.clone(),
        compression: Compression::Gzip,
        diff_id: crate::registry::sha256_digest(&tar),
    };
    let root = dir.path().join("root");
    fs::create_dir(&root).unwrap();
    apply_all(&root, std::slice::from_ref(&good)).unwrap();
    assert_eq!(fs::read(root.join("f")).unwrap(), [1, 1, 1]);
    let bad = Layer {
        diff_id: crate::registry::sha256_digest(b"other"),
        ..good
    };
    let error = apply_all(&root, &[bad]).unwrap_err();
    assert!(
        format!("{error:#}").contains("the config says"),
        "{error:#}"
    );
}
