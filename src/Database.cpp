#include "Database.hpp"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <numeric>

#include "util.hpp"

using src_loc = std::source_location;
using Types =  std::vector<uint32_t>;
using OffsetSizes = std::vector<std::pair<uint64_t, uint64_t>>;

Database::Table::Table(std::string_view storage_location, const std::optional<ColumnInfos>& column_infos):
    storage_location(std::string(storage_location))
{
    auto file_parent_path = std::filesystem::path(storage_location).parent_path();
    if(!std::filesystem::exists(file_parent_path))
        std::filesystem::create_directory(file_parent_path);

    // loading from file --------------------------------------------------------
    std::ifstream data_file(this->storage_location, std::ios_base::binary);
    if (data_file) {
        GeneralHeader general_header{};
        data_file.read(reinterpret_cast<char*>(&general_header), sizeof(general_header));
        if (general_header.magic_num != DBTABLEMAGICNUM)
            throw std::runtime_error{log_msg("Magic number for header mismatch")};
        
        // parse into the correct special header
        if (general_header.type == columnar_header_id) {
            HeaderDataColumnar header{};
            data_file.read(reinterpret_cast<char*>(&header), sizeof(header));

            // getting the column infos
            this->column_infos.id_column = header.id_column;
            std::string column_names; column_names.resize(header.column_names_len);
            data_file.seekg(header.column_names_offset, data_file.beg).read(column_names.data(), header.column_names_len);
            std::stringstream column_names_stream(column_names);
            this->column_infos.column_names.resize(header.num_columns);
            for(uint32_t i: i_range(header.num_columns))
                column_names_stream >> this->column_infos.column_names[i];
            
            Types types(header.num_columns);
            data_file.seekg(header.column_types_offset, data_file.beg).read(reinterpret_cast<char*>(types.data()), header.num_columns * sizeof(types[0]));
            
            OffsetSizes offset_sizes(header.num_columns);
            data_file.seekg(header.columns_offsets_lengths, data_file.beg).read(reinterpret_cast<char*>(offset_sizes.data()), header.num_columns * sizeof(offset_sizes[0]));
            
            if (column_infos && *column_infos != this->column_infos)
                throw std::runtime_error{log_msg("Column mismatch for stored table and requested table format")};
            

            // load data (can be loaded without seeking, as they are in the storage sequentially)
            for(auto i: i_range(header.num_columns)) {
                switch(types[i]){
                case type_id<float>():
                case type_id<double>():
                case type_id<int32_t>():
                case type_id<int64_t>():
                case type_id<uint32_t>():
                case type_id<uint64_t>():
                case type_id<std::string>():
                case type_id<Date>():
                case type_id<std::vector<std::byte>>(): return;
                }
            }
        }
        else
            throw std::runtime_error{log_msg("Unknown header type")};
    }
    
    // validating the column name strings (no spaces allowed)
    for (const auto& n: column_infos->column_names)
        if (n.find(' ') != std::string::npos)
            throw std::runtime_error{log_msg("The column names for a new table are not allowed to contain spaces.")};
    this->column_infos = *column_infos;
    this->loaded_data.resize(this->column_infos.column_names.size());
    
    store_cache();
}

void Database::Table::store_cache() {
    // TODO put into an extra worker thread which does the export in the background

    std::ofstream file(storage_location, std::ios_base::binary);
    
    // gathering header additional infos
    std::stringstream names_stream;
    for(const auto& name: column_infos.column_names)
        names_stream << name << ' ';
    std::string names_string = names_stream.str();
    Types types(column_infos.num_columns());
    for(auto i: i_range(column_infos.num_columns()))
        types[i] = loaded_data[i].index();
    std::vector<uint64_t> column_sizes(column_infos.num_columns());
    for(auto i: i_range(column_infos.num_columns())) {
        column_sizes[i] = std::visit(overloaded{
            [](const std::vector<std::string>& v) { 
                // strings are still null terminated (simply supplies best storage space)
                return std::accumulate(v.begin(), v.end(), size_t{}, [](size_t a, const std::string& s){return a + s.size();});
            },
            [](const std::vector<std::vector<std::byte>>& v) {
                // for each vector there is the byte size of the vec given as uint32_t at the beginning of the array
                return std::accumulate(v.begin(), v.end(), size_t{}, [](size_t a, const std::vector<std::byte>& v){return a + v.size() + sizeof(uint64_t);});
            },
            [](auto&& v){
                return v.size() * sizeof(v[0]);
            }
        }, loaded_data[i]);
    }
    
    // filling header infos
    GeneralHeader general_header{
        .magic_num = DBTABLEMAGICNUM, 
        .type = columnar_header_id
    };
    HeaderDataColumnar header{
        .num_columns = column_infos.num_columns(),
        .id_column = column_infos.id_column,
        .column_names_offset = static_cast<uint32_t>(sizeof(GeneralHeader) + sizeof(HeaderDataColumnar)),
        .column_names_len = static_cast<uint32_t>(names_string.length()),
        .column_types_offset = header.column_names_offset + header.column_names_len,
        .columns_offsets_lengths = header.column_types_offset + static_cast<uint32_t>(column_infos.num_columns() * sizeof(uint32_t))
    };
    size_t data_start = header.columns_offsets_lengths * 2 * column_infos.num_columns() * sizeof(uint64_t);
    
    OffsetSizes offset_lengths(column_infos.num_columns());
    for(auto i: i_range(column_infos.num_columns())){
        if (i)
            offset_lengths[i].first = offset_lengths[i - 1].first + offset_lengths[i - 1].second;
        offset_lengths[i].second = column_sizes[i];
    }

    // writing to file
    file.write(reinterpret_cast<char*>(&general_header), sizeof(general_header));
    file.write(reinterpret_cast<char*>(&header), sizeof(header));
    file.write(names_string.data(), names_string.length() * sizeof(names_string[0]));
    file.write(reinterpret_cast<char*>(types.data()), types.size() * sizeof(types[0]));
    file.write(reinterpret_cast<char*>(offset_lengths.data()), offset_lengths.size() * sizeof(offset_lengths[0]));
    for (auto i: i_range(column_infos.num_columns())) {
        std::visit(overloaded{
            [&file, &column_sizes, i](const std::vector<std::string>& v) {
                // gathering all the strings in a single buffer for submission
                std::vector<char> data(column_sizes[i]);
                size_t cur_offset{};
                for (const auto& s: v){
                    std::copy(s.data(), s.data() + s.size(), data.data() + cur_offset);
                    cur_offset += s.size();
                }
                file.write(data.data(), data.size() * sizeof(data[0]));
            },
            [&file, &column_sizes, &i](const std::vector<std::vector<std::byte>>& v) {
                std::vector<std::byte> data(column_sizes[i]);
                size_t cur_offset{};
                for (const auto& b: v) {
                    *reinterpret_cast<uint64_t*>(data.data() + cur_offset) = b.size();
                    cur_offset += sizeof(uint64_t);
                    std::copy(b.begin(), b.end(), data.begin() + cur_offset);
                }
            },
            [&file](auto&& v) { file.write(reinterpret_cast<char*>(v.data()), v.size() * sizeof(v[0])); }
        }, loaded_data[i]);
    }
}


Database::Database(std::string_view storage_location){

}