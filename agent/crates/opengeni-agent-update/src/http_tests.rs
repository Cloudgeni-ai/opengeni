use super::{HttpSource, Source, UpdateError};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

fn serve(response: impl FnOnce(TcpStream) + Send + 'static) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/artifact", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "HTTP test client never connected"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("accept HTTP test client: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
        }
        response(stream);
    });
    (url, server)
}

fn short_timeout_source() -> HttpSource {
    HttpSource {
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(200))
            .no_proxy()
            .build()
            .unwrap(),
    }
}

#[test]
fn progressing_body_can_exceed_the_default_thirty_second_timeout() {
    // Exercise the production constructor, not a longer test-only deadline.
    // Each byte arrives well within the idle budget; the body takes 32 seconds.
    let (url, server) = serve(|mut stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 33\r\n\r\n")
            .unwrap();
        for index in 0..33 {
            if index > 0 {
                thread::sleep(Duration::from_secs(1));
            }
            if stream.write_all(b"x").is_err() {
                break;
            }
        }
    });
    let started = Instant::now();
    let result = HttpSource::new().unwrap().fetch(&url);
    server.join().unwrap();
    assert_eq!(result.unwrap(), vec![b'x'; 33]);
    assert!(started.elapsed() > Duration::from_secs(30));
}

#[test]
fn stalled_body_is_still_a_download_failure() {
    let (url, server) = serve(|mut stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx")
            .unwrap();
        thread::sleep(Duration::from_millis(600));
    });
    let result = short_timeout_source().fetch(&url);
    server.join().unwrap();
    let error = result.unwrap_err();
    assert!(error.is_download_timeout(), "{error:?}");
}

#[test]
fn stalled_headers_are_still_a_download_failure() {
    let (url, server) = serve(|_stream| thread::sleep(Duration::from_millis(600)));
    let result = short_timeout_source().fetch(&url);
    server.join().unwrap();
    let error = result.unwrap_err();
    assert!(error.is_download_timeout(), "{error:?}");
}

#[test]
fn truncated_body_is_never_returned_as_success() {
    let (url, server) = serve(|mut stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx")
            .unwrap();
    });
    let result = short_timeout_source().fetch(&url);
    server.join().unwrap();
    assert!(matches!(result, Err(UpdateError::Download { .. })));
    assert!(!result.unwrap_err().is_download_timeout());
}

#[test]
fn http_failure_is_not_an_artifact() {
    let (url, server) = serve(|mut stream| {
        stream
            .write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
    });
    let result = short_timeout_source().fetch(&url);
    server.join().unwrap();
    assert!(matches!(result, Err(UpdateError::Download { .. })));
    assert!(!result.unwrap_err().is_download_timeout());
}
