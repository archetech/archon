# CI test partitioning

- When splitting the root Jest suite across required jobs, derive inclusion and exclusion from one shared path pattern. Check that test discovery is disjoint and exhaustive, keep both jobs under CI, and merge their coverage maps before publishing the existing coverage reports. Add the new check names to main branch protection so auto-merge still waits for all tests and coverage.
