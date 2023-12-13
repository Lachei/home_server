#include "data_util.hpp"
#include "nlohmann/json.hpp"
#include "util.hpp"

#include <filesystem>
#include <fstream>

namespace data_util
{
    void setup_data(std::string_view dir)
    {
        if (!std::filesystem::exists(dir))
            std::filesystem::create_directories(dir);
    }

    nlohmann::json get_dir_infos(std::string_view base, std::string_view dir)
    {
        const std::string directory = std::string(base) + dir.data();
        nlohmann::json ret{{"elements", nlohmann::json::array()}};
        if (!std::filesystem::exists(directory))
            return {{"error", "The directory does not exist"}};
        for (const auto &e : std::filesystem::directory_iterator(directory))
        {
            const auto p = e.path();
            ret["elements"].push_back(nlohmann::json{
                {"extension", p.extension().string().size() ? p.extension().string().substr(1): p.extension().string()},
                {"name", p.filename()},
                {"size", e.is_directory() ? 0: e.file_size()},
                {"changed_by", "Nobody"},
                {"change_date", to_json_date_string(std::chrono::time_point_cast<std::chrono::utc_clock::duration>(std::chrono::utc_clock::from_sys(std::chrono::file_clock::to_sys(e.last_write_time()))))},
                {"full_path", p.string().substr(base.length())}
            });
        }
        return ret;
    }

    nlohmann::json create_dir(std::string_view dir)
    {
        std::filesystem::create_directories(dir);
        return nlohmann::json{{"success", "Directory was created successfully"}};
    }

    nlohmann::json update_file(std::string_view file, std::span<const std::byte> data)
    {
        std::ofstream f(file.data(), std::ios_base::binary);
        f.write(reinterpret_cast<const char*>(data.data()), data.size());
        return {{"success", "Updated/created the file"}};
    }

    nlohmann::json delete_files(std::string_view base_dir, const nlohmann::json &files)
    {
        if (!files.is_array())
            return {{"error", "Expected array for files to delete"}};
        for (const auto& f: files) {
            const auto file = base_dir.data() + f.get<std::string>();
            if (!std::filesystem::exists(file))
                continue;
            std::filesystem::remove_all(file);
        }
        return nlohmann::json{{"success", "Removed the files/directories"}};
    }

    nlohmann::json move_files(std::string_view base_dir, const nlohmann::json &move_infos)
    {
        const bool copy = move_infos["copy"].get<bool>();
        const auto file_list = move_infos["files"];
        const auto new_file_folder = base_dir.data() + move_infos["files_to"].get<std::string>(); // this is a folder
        if (!std::filesystem::exists(new_file_folder))
            std::filesystem::create_directories(new_file_folder);
        for(auto i: i_range(file_list.size()))
        {
            const std::string src = base_dir.data() + file_list[i].get<std::string>();
            if (!std::filesystem::exists(src))
                continue;
            const std::string new_file = new_file_folder + std::filesystem::path(src).filename().string();

            if (copy)
                std::filesystem::copy(src, new_file);
            else
                std::filesystem::rename(src, new_file);
        }
        return nlohmann::json{{"success", "copied/moved the files"}};
    }

    nlohmann::json write_file(std::string_view file, std::span<const std::byte> data)
    {
        std::ofstream f(file.data(), std::ios_base::binary);
        f.write(reinterpret_cast<const char*>(data.data()), data.size());
        return nlohmann::json{{"success", "The file was successfully stored"}};
    }

    std::vector<std::byte> read_file(std::string_view file)
    {
        return {};
    }
}