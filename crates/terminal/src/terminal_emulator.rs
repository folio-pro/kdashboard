use std::mem;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term;

/// Collects events emitted by the alacritty Term.
#[derive(Clone)]
pub struct EventProxy {
    events: Arc<Mutex<Vec<Event>>>,
}

impl EventProxy {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn drain_events(&self) -> Vec<Event> {
        mem::take(&mut *self.events.lock().unwrap())
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        self.events.lock().unwrap().push(event);
    }
}

/// Dimensions type for configuring the terminal size.
pub struct TermSize {
    pub columns: usize,
    pub screen_lines: usize,
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

/// Wraps alacritty_terminal::Term + Processor for terminal emulation.
pub struct TerminalEmulator {
    term: alacritty_terminal::Term<EventProxy>,
    processor: alacritty_terminal::vte::ansi::Processor,
    event_proxy: EventProxy,
    cols: usize,
    rows: usize,
}

impl TerminalEmulator {
    pub fn new(cols: usize, rows: usize) -> Self {
        let event_proxy = EventProxy::new();
        let config = term::Config {
            scrolling_history: 5000,
            ..Default::default()
        };
        let size = TermSize {
            columns: cols,
            screen_lines: rows,
        };
        let term = alacritty_terminal::Term::new(config, &size, event_proxy.clone());
        let processor = alacritty_terminal::vte::ansi::Processor::new();

        Self {
            term,
            processor,
            event_proxy,
            cols,
            rows,
        }
    }

    /// Feed raw bytes into the terminal emulator.
    /// Returns any PtyWrite responses (e.g. from DA queries).
    pub fn write(&mut self, bytes: &[u8]) -> Vec<String> {
        for &byte in bytes {
            self.processor.advance(&mut self.term, byte);
        }
        self.event_proxy
            .drain_events()
            .into_iter()
            .filter_map(|e| match e {
                Event::PtyWrite(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    /// Scroll the terminal display by a given delta (positive = up/back in history).
    pub fn scroll(&mut self, delta: i32) {
        self.term.scroll_display(Scroll::Delta(delta));
    }

    /// Scroll the terminal display to the bottom (latest output).
    pub fn scroll_to_bottom(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }

    /// Resize the terminal to new dimensions.
    #[allow(dead_code)]
    pub fn resize(&mut self, cols: usize, rows: usize) {
        self.cols = cols;
        self.rows = rows;
        self.term.resize(TermSize {
            columns: cols,
            screen_lines: rows,
        });
    }

    /// Access the underlying Term for rendering.
    pub fn term(&self) -> &alacritty_terminal::Term<EventProxy> {
        &self.term
    }

    pub fn columns(&self) -> usize {
        self.cols
    }

    pub fn screen_lines(&self) -> usize {
        self.rows
    }
}
