# CI test partitioning

- When splitting the root Jest suite across required jobs, derive inclusion and exclusion from one shared path pattern. Check that test discovery is disjoint and exhaustive, keep both jobs under CI, and merge their coverage maps before publishing the existing coverage reports. Add the new check names to main branch protection so auto-merge still waits for all tests and coverage.

- A successful lint exit can still contain warnings. Check changed JavaScript configuration and script files with `eslint --max-warnings=0` before reporting them clean; assign configuration objects to named variables before default-exporting them.
