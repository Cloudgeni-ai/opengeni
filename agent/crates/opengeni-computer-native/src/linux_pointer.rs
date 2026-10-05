use crate::{
    NativeAction, NativeAdapterError, NativeAdapterErrorCode, NativeAdapterResult,
    NativePointerAction, NativePointerButton,
};
use opengeni_agent_proto::v1;

/// Actual X11 projection, pure so its click-pair contract can be verified without a seat.
pub(crate) fn project_pointer(
    action: &NativeAction,
    offset_x: f64,
    offset_y: f64,
    scale_x: f64,
    scale_y: f64,
) -> NativeAdapterResult<Vec<v1::DesktopInput>> {
    action.pointer_click_count().map_err(invalid_action)?;
    match action {
        NativeAction::Pointer {
            action,
            x,
            y,
            end_x,
            end_y,
            delta_x,
            delta_y,
            button,
            ..
        } => {
            let x = checked_i32(*x * scale_x + offset_x, "pointer x")?;
            let y = checked_i32(*y * scale_y + offset_y, "pointer y")?;
            let button = match button.unwrap_or(NativePointerButton::Left) {
                NativePointerButton::Left => v1::PointerButton::Left,
                NativePointerButton::Right => v1::PointerButton::Right,
                NativePointerButton::Middle => v1::PointerButton::Middle,
            };
            match action {
                NativePointerAction::Scroll => Ok(vec![desktop_input(
                    v1::desktop_input::Event::Scroll(v1::ScrollEvent {
                        x,
                        y,
                        delta_x: checked_i32(
                            delta_x.unwrap_or(0.0) * scale_x,
                            "horizontal scroll delta",
                        )?,
                        delta_y: checked_i32(
                            delta_y.unwrap_or(0.0) * scale_y,
                            "vertical scroll delta",
                        )?,
                    }),
                )]),
                NativePointerAction::Drag => {
                    let end_x = checked_i32(
                        end_x.ok_or_else(|| invalid_action("drag requires endX"))? * scale_x
                            + offset_x,
                        "drag end x",
                    )?;
                    let end_y = checked_i32(
                        end_y.ok_or_else(|| invalid_action("drag requires endY"))? * scale_y
                            + offset_y,
                        "drag end y",
                    )?;
                    Ok(vec![
                        pointer_input(x, y, v1::PointerAction::Down, button),
                        pointer_input(end_x, end_y, v1::PointerAction::Move, button),
                        pointer_input(end_x, end_y, v1::PointerAction::Up, button),
                    ])
                }
                NativePointerAction::Click
                | NativePointerAction::DoubleClick
                | NativePointerAction::Move => {
                    let action = match action {
                        NativePointerAction::Click => v1::PointerAction::Click,
                        NativePointerAction::DoubleClick => v1::PointerAction::DoubleClick,
                        NativePointerAction::Move => v1::PointerAction::Move,
                        NativePointerAction::Scroll | NativePointerAction::Drag => unreachable!(),
                    };
                    Ok(vec![pointer_input(x, y, action, button)])
                }
            }
        }

        _ => Err(invalid_action("expected pointer action")),
    }
}

fn pointer_input(
    x: i32,
    y: i32,
    action: v1::PointerAction,
    button: v1::PointerButton,
) -> v1::DesktopInput {
    desktop_input(v1::desktop_input::Event::Pointer(v1::PointerEvent {
        x,
        y,
        action: action as i32,
        button: button as i32,
    }))
}

fn desktop_input(event: v1::desktop_input::Event) -> v1::DesktopInput {
    v1::DesktopInput {
        channel_id: String::new(),
        event: Some(event),
    }
}

fn checked_i32(value: f64, label: &str) -> NativeAdapterResult<i32> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(invalid_action(format!(
            "{label} is outside the native input range"
        )));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(value.round() as i32)
}

fn invalid_action(message: impl Into<String>) -> NativeAdapterError {
    NativeAdapterError::definite(NativeAdapterErrorCode::InvalidAction, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(count: Option<u8>) -> NativeAction {
        NativeAction::Pointer {
            frame_id: "painted-a".into(),
            action: NativePointerAction::Click,
            x: 80.0,
            y: 120.0,
            end_x: None,
            end_y: None,
            delta_x: None,
            delta_y: None,
            button: Some(NativePointerButton::Left),
            click_count: count,
            continuation_of_operation_id: (count == Some(2))
                .then(|| "11111111-1111-4111-8111-111111111111".into()),
        }
    }

    #[test]
    fn click_continuation_projects_one_pair_each_and_preserves_exact_display_mapping() {
        let first = project_pointer(&click(Some(1)), -1280.0, -200.0, 0.5, 0.5).unwrap();
        let second = project_pointer(&click(Some(2)), -1280.0, -200.0, 0.5, 0.5).unwrap();
        assert_eq!(first.len() + second.len(), 2);
        for input in first.iter().chain(second.iter()) {
            let Some(v1::desktop_input::Event::Pointer(pointer)) = &input.event else {
                panic!("pointer input");
            };
            assert_eq!(pointer.action(), v1::PointerAction::Click);
            assert_eq!((pointer.x, pointer.y), (-1240, -140));
        }
        let mut explicit_double = click(None);
        if let NativeAction::Pointer { action, .. } = &mut explicit_double {
            *action = NativePointerAction::DoubleClick;
        }
        let double = project_pointer(&explicit_double, 0.0, 0.0, 1.0, 1.0).unwrap();
        let Some(v1::desktop_input::Event::Pointer(pointer)) = &double[0].event else {
            panic!("pointer input");
        };
        assert_eq!(pointer.action(), v1::PointerAction::DoubleClick);
        assert!(project_pointer(&click(Some(3)), 0.0, 0.0, 1.0, 1.0).is_err());
    }
}
