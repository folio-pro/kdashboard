use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::Hsla;

/// ANSI 16-color palette — "One Dark" style, harmonizing with the Slate/Navy theme.
const ANSI_COLORS: [Rgb; 16] = [
    Rgb {
        r: 0x28,
        g: 0x2C,
        b: 0x34,
    }, // 0  Black
    Rgb {
        r: 0xE0,
        g: 0x6C,
        b: 0x75,
    }, // 1  Red
    Rgb {
        r: 0x98,
        g: 0xC3,
        b: 0x79,
    }, // 2  Green
    Rgb {
        r: 0xE5,
        g: 0xC0,
        b: 0x7B,
    }, // 3  Yellow
    Rgb {
        r: 0x61,
        g: 0xAF,
        b: 0xEF,
    }, // 4  Blue
    Rgb {
        r: 0xC6,
        g: 0x78,
        b: 0xDD,
    }, // 5  Magenta
    Rgb {
        r: 0x56,
        g: 0xB6,
        b: 0xC2,
    }, // 6  Cyan
    Rgb {
        r: 0xAB,
        g: 0xB2,
        b: 0xBF,
    }, // 7  White
    Rgb {
        r: 0x5C,
        g: 0x63,
        b: 0x70,
    }, // 8  Bright Black
    Rgb {
        r: 0xE0,
        g: 0x6C,
        b: 0x75,
    }, // 9  Bright Red
    Rgb {
        r: 0x98,
        g: 0xC3,
        b: 0x79,
    }, // 10 Bright Green
    Rgb {
        r: 0xE5,
        g: 0xC0,
        b: 0x7B,
    }, // 11 Bright Yellow
    Rgb {
        r: 0x61,
        g: 0xAF,
        b: 0xEF,
    }, // 12 Bright Blue
    Rgb {
        r: 0xC6,
        g: 0x78,
        b: 0xDD,
    }, // 13 Bright Magenta
    Rgb {
        r: 0x56,
        g: 0xB6,
        b: 0xC2,
    }, // 14 Bright Cyan
    Rgb {
        r: 0xFF,
        g: 0xFF,
        b: 0xFF,
    }, // 15 Bright White
];

/// Default foreground — matches theme text_secondary (#94A3B8).
pub const DEFAULT_FG: Rgb = Rgb {
    r: 0x94,
    g: 0xA3,
    b: 0xB8,
};

/// Default background — matches theme surface_elevated (#0F172A).
pub const DEFAULT_BG: Rgb = Rgb {
    r: 0x0F,
    g: 0x17,
    b: 0x2A,
};

/// Cursor color — matches theme accent cyan (#22D3EE).
pub const CURSOR_COLOR: Rgb = Rgb {
    r: 0x22,
    g: 0xD3,
    b: 0xEE,
};

/// Convert an alacritty Color to an Hsla value.
///
/// `is_foreground` controls the fallback for Named::Foreground / Named::Background.
pub fn to_hsla(color: Color, term_colors: &Colors, _is_foreground: bool) -> Hsla {
    match color {
        Color::Named(name) => named_to_hsla(name, term_colors),
        Color::Spec(rgb) => rgb_to_hsla(rgb),
        Color::Indexed(idx) => {
            // Check if the terminal has overridden this index.
            if let Some(rgb) = term_colors[idx as usize] {
                rgb_to_hsla(rgb)
            } else if idx < 16 {
                rgb_to_hsla(ANSI_COLORS[idx as usize])
            } else {
                rgb_to_hsla(indexed_color(idx))
            }
        }
    }
}

fn named_to_hsla(name: NamedColor, term_colors: &Colors) -> Hsla {
    // Check if the terminal has overridden this named color.
    if let Some(rgb) = term_colors[name] {
        return rgb_to_hsla(rgb);
    }
    match name {
        NamedColor::Foreground | NamedColor::BrightForeground => rgb_to_hsla(DEFAULT_FG),
        NamedColor::Background => rgb_to_hsla(DEFAULT_BG),
        NamedColor::Cursor => rgb_to_hsla(CURSOR_COLOR),
        NamedColor::DimForeground => {
            let mut c = rgb_to_hsla(DEFAULT_FG);
            c.a *= 0.66;
            c
        }
        // Normal colors 0-7
        NamedColor::Black => rgb_to_hsla(ANSI_COLORS[0]),
        NamedColor::Red => rgb_to_hsla(ANSI_COLORS[1]),
        NamedColor::Green => rgb_to_hsla(ANSI_COLORS[2]),
        NamedColor::Yellow => rgb_to_hsla(ANSI_COLORS[3]),
        NamedColor::Blue => rgb_to_hsla(ANSI_COLORS[4]),
        NamedColor::Magenta => rgb_to_hsla(ANSI_COLORS[5]),
        NamedColor::Cyan => rgb_to_hsla(ANSI_COLORS[6]),
        NamedColor::White => rgb_to_hsla(ANSI_COLORS[7]),
        // Bright colors 8-15
        NamedColor::BrightBlack => rgb_to_hsla(ANSI_COLORS[8]),
        NamedColor::BrightRed => rgb_to_hsla(ANSI_COLORS[9]),
        NamedColor::BrightGreen => rgb_to_hsla(ANSI_COLORS[10]),
        NamedColor::BrightYellow => rgb_to_hsla(ANSI_COLORS[11]),
        NamedColor::BrightBlue => rgb_to_hsla(ANSI_COLORS[12]),
        NamedColor::BrightMagenta => rgb_to_hsla(ANSI_COLORS[13]),
        NamedColor::BrightCyan => rgb_to_hsla(ANSI_COLORS[14]),
        NamedColor::BrightWhite => rgb_to_hsla(ANSI_COLORS[15]),
        // Dim colors — darken the normal variant
        NamedColor::DimBlack => dim(ANSI_COLORS[0]),
        NamedColor::DimRed => dim(ANSI_COLORS[1]),
        NamedColor::DimGreen => dim(ANSI_COLORS[2]),
        NamedColor::DimYellow => dim(ANSI_COLORS[3]),
        NamedColor::DimBlue => dim(ANSI_COLORS[4]),
        NamedColor::DimMagenta => dim(ANSI_COLORS[5]),
        NamedColor::DimCyan => dim(ANSI_COLORS[6]),
        NamedColor::DimWhite => dim(ANSI_COLORS[7]),
    }
}

fn dim(rgb: Rgb) -> Hsla {
    let mut c = rgb_to_hsla(rgb);
    c.a *= 0.66;
    c
}

/// Compute the RGB color for indices 16-255 (the extended 256-color palette).
fn indexed_color(idx: u8) -> Rgb {
    if idx < 16 {
        ANSI_COLORS[idx as usize]
    } else if idx < 232 {
        // 6x6x6 color cube: indices 16..231
        let idx = idx - 16;
        let b = idx % 6;
        let g = (idx / 6) % 6;
        let r = idx / 36;
        let component = |c: u8| if c == 0 { 0u8 } else { 55 + 40 * c };
        Rgb {
            r: component(r),
            g: component(g),
            b: component(b),
        }
    } else {
        // Grayscale ramp: indices 232..255
        let v = 8 + 10 * (idx - 232);
        Rgb { r: v, g: v, b: v }
    }
}

/// Convert an RGB value to GPUI Hsla (via the rgba! path).
pub fn rgb_to_hsla(rgb: Rgb) -> Hsla {
    let r = rgb.r as u32;
    let g = rgb.g as u32;
    let b = rgb.b as u32;
    let rgba_value = (r << 24) | (g << 16) | (b << 8) | 0xFF;
    gpui::rgba(rgba_value).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_color_uses_ansi_for_first_16() {
        let c0 = indexed_color(0);
        let c15 = indexed_color(15);
        assert_eq!(c0, ANSI_COLORS[0]);
        assert_eq!(c15, ANSI_COLORS[15]);
    }

    #[test]
    fn indexed_color_maps_6x6x6_cube() {
        let c16 = indexed_color(16);
        let c21 = indexed_color(21);
        let c52 = indexed_color(52);

        assert_eq!(c16, Rgb { r: 0, g: 0, b: 0 });
        assert_eq!(c21, Rgb { r: 0, g: 0, b: 255 });
        assert_eq!(c52, Rgb { r: 95, g: 0, b: 0 });
    }

    #[test]
    fn indexed_color_maps_grayscale_ramp() {
        assert_eq!(indexed_color(232), Rgb { r: 8, g: 8, b: 8 });
        assert_eq!(
            indexed_color(255),
            Rgb {
                r: 238,
                g: 238,
                b: 238
            }
        );
    }

    #[test]
    fn named_to_hsla_defaults_for_core_named_colors() {
        let term_colors = Colors::default();
        let fg = named_to_hsla(NamedColor::Foreground, &term_colors);
        let bg = named_to_hsla(NamedColor::Background, &term_colors);
        let cursor = named_to_hsla(NamedColor::Cursor, &term_colors);
        let dim_fg = named_to_hsla(NamedColor::DimForeground, &term_colors);

        assert_eq!(fg, rgb_to_hsla(DEFAULT_FG));
        assert_eq!(bg, rgb_to_hsla(DEFAULT_BG));
        assert_eq!(cursor, rgb_to_hsla(CURSOR_COLOR));
        assert!(dim_fg.a < fg.a);
    }

    #[test]
    fn to_hsla_handles_indexed_color_without_overrides() {
        let term_colors = Colors::default();
        let hsla = to_hsla(Color::Indexed(232), &term_colors, true);
        assert_eq!(hsla, rgb_to_hsla(Rgb { r: 8, g: 8, b: 8 }));
    }
}
