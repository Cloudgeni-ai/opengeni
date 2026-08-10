//! Minimal retained wrapper around Apple's AXUIElement C API.
//!
//! This intentionally replaces the legacy `accessibility` convenience crate:
//! OpenGeni needs only a small subset, and owning it keeps the entire unsafe AX
//! surface in this audited leaf without pulling old Cocoa/Objective-C bindings.

use core::fmt;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::CFString;
use core_foundation::{declare_TCFType, impl_CFTypeDescription, impl_TCFType};

use accessibility_sys::{
    error_string, kAXErrorSuccess, AXError, AXUIElementCopyActionNames,
    AXUIElementCopyAttributeValue, AXUIElementCopyAttributeValues, AXUIElementCreateApplication,
    AXUIElementGetAttributeValueCount, AXUIElementGetTypeID, AXUIElementIsAttributeSettable,
    AXUIElementPerformAction, AXUIElementRef, AXUIElementSetAttributeValue,
    AXUIElementSetMessagingTimeout,
};

declare_TCFType!(AxElement, AXUIElementRef);
impl_TCFType!(AxElement, AXUIElementRef, AXUIElementGetTypeID);
impl_CFTypeDescription!(AxElement);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AxCallError(AXError);

impl fmt::Display for AxCallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", error_string(self.0), self.0)
    }
}

impl std::error::Error for AxCallError {}

impl AxElement {
    pub(super) fn application(pid: i32) -> Self {
        unsafe { Self::wrap_under_create_rule(AXUIElementCreateApplication(pid)) }
    }

    pub(super) fn set_messaging_timeout(&self, seconds: f32) -> Result<(), AxCallError> {
        ax_void(unsafe { AXUIElementSetMessagingTimeout(self.as_concrete_TypeRef(), seconds) })
    }

    pub(super) fn attribute(&self, name: &str) -> Result<CFType, AxCallError> {
        let name = CFString::new(name);
        let mut value = core::ptr::null();
        ax_void(unsafe {
            AXUIElementCopyAttributeValue(
                self.as_concrete_TypeRef(),
                name.as_concrete_TypeRef(),
                &raw mut value,
            )
        })?;
        if value.is_null() {
            return Err(AxCallError(accessibility_sys::kAXErrorNoValue));
        }
        Ok(unsafe { CFType::wrap_under_create_rule(value) })
    }

    pub(super) fn string_attribute(&self, name: &str) -> Result<CFString, AxCallError> {
        self.attribute(name)?
            .downcast::<CFString>()
            .ok_or(AxCallError(accessibility_sys::kAXErrorIllegalArgument))
    }

    pub(super) fn bool_attribute(&self, name: &str) -> Result<CFBoolean, AxCallError> {
        self.attribute(name)?
            .downcast::<CFBoolean>()
            .ok_or(AxCallError(accessibility_sys::kAXErrorIllegalArgument))
    }

    pub(super) fn element_array_bounded(
        &self,
        name: &str,
        max_values: usize,
    ) -> Result<(Vec<Self>, bool), AxCallError> {
        let name = CFString::new(name);
        let mut count = 0;
        ax_void(unsafe {
            AXUIElementGetAttributeValueCount(
                self.as_concrete_TypeRef(),
                name.as_concrete_TypeRef(),
                &raw mut count,
            )
        })?;
        let count = usize::try_from(count)
            .map_err(|_| AxCallError(accessibility_sys::kAXErrorIllegalArgument))?;
        let requested = count.min(max_values);
        if requested == 0 {
            return Ok((Vec::new(), count > 0));
        }
        let mut value = core::ptr::null();
        ax_void(unsafe {
            AXUIElementCopyAttributeValues(
                self.as_concrete_TypeRef(),
                name.as_concrete_TypeRef(),
                0,
                isize::try_from(requested)
                    .map_err(|_| AxCallError(accessibility_sys::kAXErrorIllegalArgument))?,
                &raw mut value,
            )
        })?;
        if value.is_null() {
            return Err(AxCallError(accessibility_sys::kAXErrorNoValue));
        }
        let values = unsafe { CFArray::<Self>::wrap_under_create_rule(value.cast()) };
        Ok((
            values.into_iter().map(|value| (*value).clone()).collect(),
            count > requested,
        ))
    }

    pub(super) fn children_bounded(
        &self,
        max_values: usize,
    ) -> Result<(Vec<Self>, bool), AxCallError> {
        self.element_array_bounded(accessibility_sys::kAXChildrenAttribute, max_values)
    }

    pub(super) fn windows_bounded(
        &self,
        max_values: usize,
    ) -> Result<(Vec<Self>, bool), AxCallError> {
        self.element_array_bounded(accessibility_sys::kAXWindowsAttribute, max_values)
    }

    pub(super) fn child_at(&self, child_index: usize) -> Result<Self, AxCallError> {
        let name = CFString::new(accessibility_sys::kAXChildrenAttribute);
        let mut value = core::ptr::null();
        ax_void(unsafe {
            AXUIElementCopyAttributeValues(
                self.as_concrete_TypeRef(),
                name.as_concrete_TypeRef(),
                isize::try_from(child_index)
                    .map_err(|_| AxCallError(accessibility_sys::kAXErrorIllegalArgument))?,
                1,
                &raw mut value,
            )
        })?;
        if value.is_null() {
            return Err(AxCallError(accessibility_sys::kAXErrorNoValue));
        }
        let values = unsafe { CFArray::<Self>::wrap_under_create_rule(value.cast()) };
        values
            .into_iter()
            .next()
            .map(|value| (*value).clone())
            .ok_or(AxCallError(accessibility_sys::kAXErrorNoValue))
    }

    pub(super) fn action_names(&self) -> Result<Vec<CFString>, AxCallError> {
        let mut names = core::ptr::null();
        ax_void(unsafe { AXUIElementCopyActionNames(self.as_concrete_TypeRef(), &raw mut names) })?;
        if names.is_null() {
            return Err(AxCallError(accessibility_sys::kAXErrorNoValue));
        }
        let names = unsafe { CFArray::<CFString>::wrap_under_create_rule(names) };
        Ok(names.into_iter().map(|name| (*name).clone()).collect())
    }

    pub(super) fn is_settable(&self, name: &str) -> Result<bool, AxCallError> {
        let name = CFString::new(name);
        let mut settable = 0_u8;
        ax_void(unsafe {
            AXUIElementIsAttributeSettable(
                self.as_concrete_TypeRef(),
                name.as_concrete_TypeRef(),
                &raw mut settable,
            )
        })?;
        Ok(settable != 0)
    }

    pub(super) fn set_attribute(&self, name: &str, value: &CFType) -> Result<(), AxCallError> {
        let name = CFString::new(name);
        ax_void(unsafe {
            AXUIElementSetAttributeValue(
                self.as_concrete_TypeRef(),
                name.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            )
        })
    }

    pub(super) fn perform_action(&self, name: &str) -> Result<(), AxCallError> {
        let name = CFString::new(name);
        ax_void(unsafe {
            AXUIElementPerformAction(self.as_concrete_TypeRef(), name.as_concrete_TypeRef())
        })
    }
}

fn ax_void(result: AXError) -> Result<(), AxCallError> {
    if result == kAXErrorSuccess {
        Ok(())
    } else {
        Err(AxCallError(result))
    }
}
