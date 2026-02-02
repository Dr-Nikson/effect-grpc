---
"@dr_nikson/effect-grpc": patch
---

Fix duplicate suffix in generated service names (#30)

Services with names already ending in "Service" (e.g., `HelloWorldService`) no longer produce duplicated names like `HelloWorldServiceService`. The code generator now correctly strips the suffix before applying naming conventions.
