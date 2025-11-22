#pragma once

#include <string>

namespace git_util {
    void init_git(std::string_view path);
    std::string get_file_at_version(std::string_view path, std::string_view version);
    std::string get_latest_commit_hash(std::string_view file);
    std::string try_get_latest_commit_hash(std::string_view file);
    /** @brief returns the hash of the commit */
    std::string commit_changes(std::string_view user);
    std::string try_commit_changes(std::string_view user, std::string_view path);
    std::string merge_strings(std::string_view base_version, std::string_view a, std::string_view b);
}
