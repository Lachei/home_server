#pragma once

#include <string_view>
#include <string>
#include <variant>
#include <vector>
#include <array>
#include <chrono>
#include <inttypes.h>

constexpr uint64_t DBTABLEMAGICNUM = 0x409ca93b33af;
constexpr uint32_t DBTABLEKINDSTRINGLEN = 4;
namespace detail{
    template<typename T> constexpr uint32_t type_id() {return 0;};
    template<> constexpr uint32_t type_id<float>() {return 1;};
    template<> constexpr uint32_t type_id<double>() {return 2;};
    template<> constexpr uint32_t type_id<int32_t>() {return 3;};
    template<> constexpr uint32_t type_id<int64_t>() {return 4;};
    template<> constexpr uint32_t type_id<uint32_t>() {return 5;};
    template<> constexpr uint32_t type_id<uint64_t>() {return 6;};
    template<> constexpr uint32_t type_id<std::string>() {return 7;};
    template<> constexpr uint32_t type_id<std::chrono::system_clock::time_point>() {return 8;};
    template<> constexpr uint32_t type_id<std::vector<std::byte>>() {return 9;};
    constexpr std::array<char, DBTABLEKINDSTRINGLEN> columnar_header_id{'c','o','l','1'};
}

// Class to store all kinds of tabular data, data is stored in column major format
class Database{
public:
    using ColumnType = std::variant<std::vector<float>, 
                                    std::vector<double>,
                                    std::vector<int32_t>, 
                                    std::vector<int64_t>, 
                                    std::vector<uint32_t>, 
                                    std::vector<uint64_t>, 
                                    std::vector<std::string>, 
                                    std::vector<std::chrono::system_clock::time_point>, 
                                    std::vector<std::vector<std::byte>>>;
    struct Table{
        // there might be more header datas coming, currently only columnar is available
        struct GeneralHeader{
            uint64_t magic_num;
            std::array<char, DBTABLEKINDSTRINGLEN> type;
        };
        struct HeaderDataColumnar{
            // The data layout is the following (number after colon is the byte offset)
            // GeneralHeader: 0,
            // HeaderDataColumnar: sizeof(GeneralHeader),
            // ColumnNames: column_names_offset
            // ColumnTypes: column_types_offset
            // ColumnOffsetsLengths: columns_offset_lengths_offset (for each column one offset + length exists here)
            // Columns
            uint32_t num_columns;
            uint32_t id_column;
            uint32_t column_names_offset;
            uint32_t column_names_len;
            uint32_t column_types_offset;
            uint32_t columns_offsets_lengths_types_offset;
        };
        template<typename T> constexpr uint32_t type_id() {return detail::type_id<T>();};

        std::string storage_location{};
        std::vector<ColumnType> loaded_data{};  // this is only the data cache, might be missing part of the data in the file
        uint64_t loaded_data_offset{};
        struct ColumnInfos{
            std::vector<std::string> column_names{};
            std::vector<uint32_t> column_type_ids{};
            uint id_column{};
            
            bool operator<=>(const ColumnInfos&) const = default;
        } column_infos{};
        
        // If column_infos is empty, the table layout is loaded from the stored data.
        // If no column_infos is given and the file does not exist on the computer an error will be thrown
        Table(std::string_view storage_location, const std::optional<ColumnInfos>& column_infos = {});
        
        
    };
    
    Database(std::string_view storage_location);

private:
    std::string _storage_location;

};
