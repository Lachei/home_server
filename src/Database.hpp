#pragma once

#include <string_view>
#include <string>
#include <variant>
#include <vector>
#include <inttypes.h>

// Class to store all kinds of tabular data, data is stored in column major format
class Database{
public:
    using Type = std::variant<float, double, int32_t, int64_t, uint32_t, uint64_t, std::string>;
    struct Table{
        std::string storage_location;
        std::vector<std::vector<Type>> loaded_data;  // this is only the data cache, might be missing part of the data in the file
        uint id_column;
    };

private:
    std::string _storage_location;

};